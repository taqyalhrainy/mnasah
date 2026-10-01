import Peer, { DataConnection, MediaConnection } from 'peerjs';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteVideoSource: (source: VideoSource) => void;
  onWhiteboardMessage?: (message: unknown) => void;
  onDataOpen?: () => void;
  onLocalPeerId?: (peerId: string | null) => void | Promise<void>;
  getRemotePeerId?: () => Promise<string | null | undefined>;
  onLocalVideoSource: (source: VideoSource) => void;
  onPeerLeft: () => void;
  onStatus: (status: string) => void;
};

export type VideoRole = 'teacher' | 'student';
export type VideoSource = 'camera' | 'screen';

function normalizeRoomId(roomId: string) {
  return roomId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export class VideoConnection {
  private peer?: Peer;
  private activeCall?: MediaConnection;
  private activeDataConnection?: DataConnection;
  private pendingCalls = new Set<MediaConnection>();
  private pendingDataConnections = new Set<DataConnection>();
  private localStream?: MediaStream;
  private cameraTrack?: MediaStreamTrack;
  private screenTrack?: MediaStreamTrack;
  private videoSource: VideoSource = 'camera';
  private retryTimer?: number;
  private hasRemoteStream = false;
  private closed = false;
  private remotePeerId?: string;
  private discoveryInFlight = false;

  constructor(
    private readonly roomId: string,
    private readonly role: VideoRole,
    private readonly callbacks: PeerCallbacks,
  ) {}

  async start() {
    this.closed = false;
    const cleanRoomId = normalizeRoomId(this.roomId);
    if (!cleanRoomId) {
      throw new Error('اكتب رقم غرفة صحيح');
    }

    this.callbacks.onStatus('جاري تشغيل الكاميرا والمايك');
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user',
      },
    });
    this.cameraTrack = this.localStream.getVideoTracks()[0];

    this.createPeer();
    return this.localStream;
  }

  toggleAudio(enabled: boolean) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  toggleVideo(enabled: boolean) {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  async startScreenShare() {
    if (!this.localStream) {
      throw new Error('ابدأ الجلسة قبل مشاركة الشاشة');
    }

    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('مشاركة الشاشة غير مدعومة على هذا المتصفح');
    }

    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const [screenTrack] = screenStream.getVideoTracks();
    if (!screenTrack) {
      throw new Error('لم يتم اختيار شاشة للمشاركة');
    }

    this.screenTrack = screenTrack;
    this.videoSource = 'screen';
    await this.replaceOutgoingVideoTrack(screenTrack);
    this.replaceLocalPreviewTrack(screenTrack);
    this.callbacks.onLocalVideoSource('screen');
    this.sendVideoSource();
    this.callbacks.onStatus('مشاركة الشاشة تعمل الآن');

    screenTrack.onended = () => {
      void this.stopScreenShare();
    };

    return this.localStream;
  }

  async stopScreenShare() {
    if (!this.localStream || !this.cameraTrack) return this.localStream;

    const screenTrack = this.screenTrack;
    this.screenTrack = undefined;
    this.videoSource = 'camera';
    await this.replaceOutgoingVideoTrack(this.cameraTrack);
    this.replaceLocalPreviewTrack(this.cameraTrack);
    this.callbacks.onLocalVideoSource('camera');
    this.sendVideoSource();
    this.callbacks.onStatus(this.hasRemoteStream ? 'الاتصال مباشر' : 'بانتظار دخول الطرف الثاني بنفس كود الغرفة');
    if (screenTrack) {
      screenTrack.onended = null;
      screenTrack.stop();
    }

    return this.localStream;
  }

  close() {
    this.closed = true;
    if (this.retryTimer) window.clearInterval(this.retryTimer);
    void this.callbacks.onLocalPeerId?.(null);
    this.activeCall?.close();
    this.activeDataConnection?.close();
    this.pendingCalls.forEach(call => call.close());
    this.pendingDataConnections.forEach(connection => connection.close());
    this.pendingCalls.clear();
    this.pendingDataConnections.clear();
    this.peer?.destroy();
    this.screenTrack?.stop();
    this.localStream?.getTracks().forEach((track) => track.stop());
  }

  private async replaceOutgoingVideoTrack(track: MediaStreamTrack) {
    const sender = this.activeCall?.peerConnection
      .getSenders()
      .find((candidate) => candidate.track?.kind === 'video');

    await sender?.replaceTrack(track);
  }

  private replaceLocalPreviewTrack(track: MediaStreamTrack) {
    if (!this.localStream) return;

    this.localStream.getVideoTracks().forEach((oldTrack) => {
      this.localStream?.removeTrack(oldTrack);
    });
    this.localStream.addTrack(track);
  }

  private bindPeerEvents(peer: Peer) {
    if (!this.localStream) return;

    peer.on('open', (peerId) => {
      if (this.closed || this.peer !== peer) return;
      void this.callbacks.onLocalPeerId?.(peerId);
      this.callbacks.onStatus('بانتظار دخول الطرف الثاني بنفس كود الغرفة');
      this.startPeerSearch();
    });

    peer.on('call', (call) => {
      if (this.closed || this.peer !== peer) {
        call.close();
        return;
      }
      // Keep one deterministic media-call direction. If both sides dial at the
      // same time after a participant returns, each side can close the call the
      // other side is answering and both remain stuck on "reconnecting".
      if (this.role === 'teacher') {
        call.close();
        if (this.remotePeerId) this.callStudent(this.remotePeerId);
        return;
      }

      this.callbacks.onStatus('جاري قبول الاتصال');
      call.answer(this.localStream!);
      this.bindCallEvents(call);
      const peerChanged = this.remotePeerId !== call.peer;
      this.remotePeerId = call.peer;
      this.ensureStudentDataConnection(call.peer, peerChanged);
    });

    peer.on('connection', (connection) => {
      if (this.closed || this.peer !== peer) {
        connection.close();
        return;
      }
      if (this.role === 'student') {
        connection.close();
        if (this.remotePeerId) this.ensureStudentDataConnection(this.remotePeerId);
        return;
      }
      this.bindDataConnection(connection);
    });

    peer.on('error', (error) => {
      if (this.closed || this.peer !== peer) return;
      if (error.type === 'unavailable-id') {
        this.callbacks.onStatus('تعذر إنشاء معرّف جديد للجلسة');
        return;
      }

      if (error.type === 'peer-unavailable') {
        if (!this.hasRemoteStream) this.callbacks.onStatus('بانتظار دخول الطرف الثاني بنفس كود الغرفة');
        return;
      }

      this.callbacks.onStatus(error.message || 'تعذر إنشاء الاتصال');
    });

    peer.on('disconnected', () => {
      if (this.closed || this.peer !== peer) return;
      this.callbacks.onStatus('انقطع اتصال الإشارة، حاول بدء الجلسة مرة أخرى');
      this.reconnectSignaling();
    });
  }

  private createPeer() {
    if (this.closed) return;
    const peer = new Peer({
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });
    this.peer = peer;
    this.bindPeerEvents(peer);
  }

  reconnectSignaling() {
    if (!this.peer || this.peer.destroyed || !this.peer.disconnected) return;

    try {
      this.peer.reconnect();
      this.callbacks.onStatus(this.hasRemoteStream ? 'الاتصال مباشر' : 'جاري إعادة الاتصال');
    } catch {
      this.callbacks.onStatus('تعذر إعادة الاتصال تلقائياً');
    }
  }

  resumeAfterBackground() {
    this.reconnectSignaling();

    if (!this.hasRemoteStream) {
      this.startPeerSearch();
    }
  }

  sendWhiteboard(message: unknown) {
    if (!this.activeDataConnection?.open) return false;
    this.activeDataConnection.send({ type: 'whiteboard', message });
    return true;
  }

  private startPeerSearch() {
    if (this.closed) return;
    if (this.retryTimer) window.clearInterval(this.retryTimer);

    const findOtherPeer = async () => {
      if (this.closed || this.discoveryInFlight || !this.callbacks.getRemotePeerId) return;
      this.discoveryInFlight = true;
      try {
        const discoveredPeerId = await this.callbacks.getRemotePeerId();
        if (this.closed || !discoveredPeerId) return;
        const peerChanged = discoveredPeerId !== this.remotePeerId;
        this.remotePeerId = discoveredPeerId;
        if (this.role === 'teacher') {
          this.callStudent(discoveredPeerId, peerChanged);
        } else {
          this.ensureStudentDataConnection(discoveredPeerId, peerChanged);
        }
      } catch {
        if (!this.hasRemoteStream) this.callbacks.onStatus('جاري إعادة الاتصال');
      } finally {
        this.discoveryInFlight = false;
      }
    };

    void findOtherPeer();
    this.retryTimer = window.setInterval(() => void findOtherPeer(), 1500);
  }

  private callStudent(targetPeerId: string, replaceStaleCall = false) {
    if (this.closed || this.role !== 'teacher' || !this.peer?.open || !this.localStream) return;
    if (!replaceStaleCall && (this.activeCall || this.hasRemoteStream || this.pendingCalls.size)) return;

    if (replaceStaleCall) {
      const staleCall = this.activeCall;
      this.activeCall = undefined;
      this.hasRemoteStream = false;
      staleCall?.close();
      this.pendingCalls.forEach(call => call.close());
      this.pendingCalls.clear();
      this.callbacks.onPeerLeft();
    }

    this.callbacks.onStatus('جاري البحث عن الطالب');
    this.bindCallEvents(this.peer.call(targetPeerId, this.localStream));
  }

  private ensureStudentDataConnection(targetPeerId: string, replaceStaleConnection = false) {
    if (this.closed || this.role !== 'student' || !this.peer?.open) return;
    if (!replaceStaleConnection && (this.activeDataConnection?.open || this.pendingDataConnections.size)) return;
    if (replaceStaleConnection) {
      this.activeDataConnection?.close();
      this.activeDataConnection = undefined;
      this.pendingDataConnections.forEach(connection => connection.close());
      this.pendingDataConnections.clear();
    }
    this.bindDataConnection(this.peer.connect(targetPeerId, { reliable: true }));
  }

  private bindCallEvents(call: MediaConnection) {
    this.pendingCalls.add(call);

    call.on('stream', (remoteStream) => {
      if (this.closed) {
        call.close();
        return;
      }
      const previousCall = this.activeCall;
      this.activeCall = call;
      this.hasRemoteStream = true;
      this.pendingCalls.delete(call);
      this.pendingCalls.forEach(candidate => candidate.close());
      this.pendingCalls.clear();
      if (previousCall && previousCall !== call) previousCall.close();
      this.callbacks.onRemoteStream(remoteStream);
      this.callbacks.onStatus('الاتصال مباشر');

      remoteStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => this.handleCallEnded(call), { once: true });
      });
    });

    call.on('close', () => {
      this.pendingCalls.delete(call);
      this.handleCallEnded(call);
    });

    call.on('error', (error) => {
      this.pendingCalls.delete(call);
      if (this.closed || this.activeCall !== call) return;
      this.hasRemoteStream = false;
      this.activeCall = undefined;
      this.callbacks.onPeerLeft();
      this.callbacks.onStatus(error.message || 'تعذر إكمال المكالمة');
      this.startPeerSearch();
    });
  }

  private handleCallEnded(call: MediaConnection) {
    // Closing a superseded call must not tear down the fresh replacement.
    if (this.closed || this.activeCall !== call) return;
    this.hasRemoteStream = false;
    this.activeCall = undefined;
    this.callbacks.onPeerLeft();
    this.callbacks.onStatus('غادر الطرف الآخر الجلسة، بانتظار عودته');
    this.startPeerSearch();
  }

  private bindDataConnection(connection: DataConnection) {
    this.pendingDataConnections.add(connection);

    connection.on('open', () => {
      if (this.closed) {
        connection.close();
        return;
      }
      if (this.activeDataConnection?.open && this.activeDataConnection !== connection) {
        connection.close();
        return;
      }
      this.activeDataConnection = connection;
      this.pendingDataConnections.delete(connection);
      this.pendingDataConnections.forEach(candidate => candidate.close());
      this.pendingDataConnections.clear();
      this.sendVideoSource();
      this.callbacks.onDataOpen?.();
      // A fresh student data channel is an explicit presence handshake and
      // replaces any media connection that belongs to the previous session.
      if (this.role === 'teacher' && this.activeCall?.peer !== connection.peer) {
        this.remotePeerId = connection.peer;
        this.callStudent(connection.peer, true);
      }
    });

    connection.on('data', (message) => {
      if (isVideoSourceMessage(message)) {
        this.callbacks.onRemoteVideoSource(message.source);
        return;
      }
      if (isWhiteboardMessage(message)) this.callbacks.onWhiteboardMessage?.(message.message);
    });

    connection.on('close', () => {
      this.pendingDataConnections.delete(connection);
      if (this.activeDataConnection !== connection) return;
      this.activeDataConnection = undefined;
      if (this.role === 'student' && this.remotePeerId) this.ensureStudentDataConnection(this.remotePeerId);
    });

    connection.on('error', () => {
      this.pendingDataConnections.delete(connection);
      if (this.activeDataConnection !== connection) return;
      this.activeDataConnection = undefined;
      if (this.role === 'student' && this.remotePeerId) this.ensureStudentDataConnection(this.remotePeerId);
    });
  }

  private sendVideoSource() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'video-source', source: this.videoSource });
  }
}

function isWhiteboardMessage(message: unknown): message is { type: 'whiteboard'; message: unknown } {
  if (!message || typeof message !== 'object') return false;
  return (message as { type?: unknown }).type === 'whiteboard';
}

function isVideoSourceMessage(message: unknown): message is { type: 'video-source'; source: VideoSource } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; source?: unknown };

  return candidate.type === 'video-source' && (candidate.source === 'camera' || candidate.source === 'screen');
}
