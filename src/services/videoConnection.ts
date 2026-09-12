import Peer, { DataConnection, MediaConnection } from 'peerjs';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteVideoSource: (source: VideoSource) => void;
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

function getPeerId(roomId: string, role: VideoRole) {
  return `mansah-${normalizeRoomId(roomId)}-${role}`;
}

export class VideoConnection {
  private peer?: Peer;
  private activeCall?: MediaConnection;
  private activeDataConnection?: DataConnection;
  private localStream?: MediaStream;
  private cameraTrack?: MediaStreamTrack;
  private screenTrack?: MediaStreamTrack;
  private videoSource: VideoSource = 'camera';
  private cleanRoomId?: string;
  private retryTimer?: number;
  private hasRemoteStream = false;

  constructor(
    private readonly roomId: string,
    private readonly role: VideoRole,
    private readonly callbacks: PeerCallbacks,
  ) {}

  async start() {
    const cleanRoomId = normalizeRoomId(this.roomId);
    if (!cleanRoomId) {
      throw new Error('اكتب رقم غرفة صحيح');
    }
    this.cleanRoomId = cleanRoomId;

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

    this.peer = new Peer(getPeerId(cleanRoomId, this.role), {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });

    this.bindPeerEvents(cleanRoomId);
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
    if (this.retryTimer) window.clearInterval(this.retryTimer);
    this.activeCall?.close();
    this.activeDataConnection?.close();
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

  private bindPeerEvents(cleanRoomId: string) {
    if (!this.peer || !this.localStream) return;

    this.peer.on('open', () => {
      this.callbacks.onStatus('بانتظار دخول الطرف الثاني بنفس كود الغرفة');
      this.startPeerSearch(cleanRoomId);
    });

    this.peer.on('call', (call) => {
      if (this.hasRemoteStream) {
        call.close();
        return;
      }

      this.activeCall?.close();
      this.callbacks.onStatus('جاري قبول الاتصال');
      call.answer(this.localStream!);
      this.bindCallEvents(call);
    });

    this.peer.on('connection', (connection) => {
      this.bindDataConnection(connection);
    });

    this.peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        this.callbacks.onStatus('هذا الدور مفتوح حالياً في نفس الغرفة');
        return;
      }

      if (error.type === 'peer-unavailable') {
        this.callbacks.onStatus('بانتظار دخول الطرف الثاني بنفس كود الغرفة');
        return;
      }

      this.callbacks.onStatus(error.message || 'تعذر إنشاء الاتصال');
    });

    this.peer.on('disconnected', () => {
      this.callbacks.onStatus('انقطع اتصال الإشارة، حاول بدء الجلسة مرة أخرى');
      this.reconnectSignaling();
    });
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

    if (!this.hasRemoteStream && this.cleanRoomId) {
      this.startPeerSearch(this.cleanRoomId);
    }
  }

  private startPeerSearch(cleanRoomId: string) {
    if (this.retryTimer) window.clearInterval(this.retryTimer);

    const callOtherPeer = () => {
      if (!this.peer || !this.localStream || this.activeCall || this.hasRemoteStream) return;

      const otherRole: VideoRole = this.role === 'teacher' ? 'student' : 'teacher';
      const otherPeerId = getPeerId(cleanRoomId, otherRole);
      if (!this.activeDataConnection) {
        this.bindDataConnection(this.peer.connect(otherPeerId, { reliable: true }));
      }

      const call = this.peer.call(otherPeerId, this.localStream);
      this.callbacks.onStatus('جاري البحث عن الطرف الثاني');
      this.bindCallEvents(call);
    };

    callOtherPeer();
    this.retryTimer = window.setInterval(callOtherPeer, 2500);
  }

  private bindCallEvents(call: MediaConnection) {
    this.activeCall?.close();
    this.activeCall = call;

    call.on('stream', (remoteStream) => {
      this.hasRemoteStream = true;
      if (this.retryTimer) window.clearInterval(this.retryTimer);
      this.callbacks.onRemoteStream(remoteStream);
      this.callbacks.onStatus('الاتصال مباشر');
    });

    call.on('close', () => {
      this.hasRemoteStream = false;
      if (this.activeCall === call) this.activeCall = undefined;
      this.callbacks.onPeerLeft();
      this.callbacks.onStatus('غادر الطرف الآخر الجلسة');
    });

    call.on('error', (error) => {
      if (this.activeCall === call) this.activeCall = undefined;

      this.callbacks.onStatus(error.message || 'تعذر إكمال المكالمة');
    });
  }

  private bindDataConnection(connection: DataConnection) {
    this.activeDataConnection?.close();
    this.activeDataConnection = connection;

    connection.on('open', () => {
      this.sendVideoSource();
    });

    connection.on('data', (message) => {
      if (!isVideoSourceMessage(message)) return;
      this.callbacks.onRemoteVideoSource(message.source);
    });

    connection.on('close', () => {
      if (this.activeDataConnection === connection) this.activeDataConnection = undefined;
    });
  }

  private sendVideoSource() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'video-source', source: this.videoSource });
  }
}

function isVideoSourceMessage(message: unknown): message is { type: 'video-source'; source: VideoSource } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; source?: unknown };

  return candidate.type === 'video-source' && (candidate.source === 'camera' || candidate.source === 'screen');
}
