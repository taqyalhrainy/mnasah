import { t } from '../i18n/preferences';
import { request } from './platformApi';
import Peer, { DataConnection, MediaConnection } from 'peerjs';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteVideoSource: (source: VideoSource) => void;
  onRemoteVideoEnabled?: (enabled: boolean) => void;
  onWhiteboardMessage?: (message: unknown) => void;
  onRemoteTyping?: (typing: boolean) => void;
  onRemoteSpeaking?: (speaking: boolean) => void;
  onDataOpen?: () => void;
  onLocalPeerId?: (peerId: string | null) => void | Promise<void>;
  getRemotePeerId?: () => Promise<string | null | undefined>;
  onLocalVideoSource: (source: VideoSource) => void;
  onPeerLeft: () => void;
  onStatus: (status: string) => void;
};

export type VideoRole = 'teacher' | 'student';
export type VideoSource = 'camera' | 'screen';

const turnUrls = String(import.meta.env.VITE_TURN_URLS || import.meta.env.VITE_TURN_URL || '').split(',').map(value => value.trim()).filter(Boolean);
const turnUsername = String(import.meta.env.VITE_TURN_USERNAME || '').trim();
const turnCredential = String(import.meta.env.VITE_TURN_CREDENTIAL || '').trim();
const hasTurnServer = turnUrls.length > 0 && Boolean(turnUsername && turnCredential);
const iceServers: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478'] },
  ...(hasTurnServer ? [{ urls: turnUrls, username: turnUsername, credential: turnCredential }] : []),
];

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
  private placeholderVideoTrack?: MediaStreamTrack;
  private screenTrack?: MediaStreamTrack;
  private videoSource: VideoSource = 'camera';
  private videoEnabled = false;
  private audioEnabled = true;
  private retryTimer?: number;
  private hasRemoteStream = false;
  private closed = false;
  private remotePeerId?: string;
  private discoveryInFlight = false;
  private callTimeouts = new WeakMap<MediaConnection, number>();
  private diagnosedCalls = new WeakSet<MediaConnection>();
  private resolvedIceServers: RTCIceServer[] = iceServers;

  constructor(
    private readonly roomId: string,
    private readonly role: VideoRole,
    private readonly callbacks: PeerCallbacks,
  ) {}

  async start() {
    this.closed = false;
    const cleanRoomId = normalizeRoomId(this.roomId);
    if (!cleanRoomId) {
      throw new Error(t("اكتب رقم غرفة صحيح"));
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(t('الكاميرا والمايك يحتاجان متصفحاً حديثاً واتصال HTTPS.'));
    }

    this.callbacks.onStatus(t("جاري تشغيل المايك"));
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (cause) {
      const error = cause as DOMException;
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        throw new Error(t('اسمح للمتصفح باستخدام المايك ثم حاول مجدداً.'));
      }
      throw new Error(t('تعذر تشغيل المايك على هذا الجهاز. أغلق أي تطبيق يستخدمه ثم حاول مجدداً.'));
    }
    this.placeholderVideoTrack = this.createPlaceholderVideoTrack();
    if (this.placeholderVideoTrack) this.localStream.addTrack(this.placeholderVideoTrack);

    try {
      const result = await request<{ ice_servers?: RTCIceServer[] }>(`${this.role}s/video/ice`);
      if (Array.isArray(result.ice_servers) && result.ice_servers.length) this.resolvedIceServers = result.ice_servers;
    } catch { /* Static STUN/TURN configuration remains available as a fallback. */ }

    this.createPeer();
    return this.localStream;
  }

  toggleAudio(enabled: boolean) {
    this.audioEnabled = enabled;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    if (enabled) void this.repairAudio();
  }

  async repairAudio() {
    if (this.closed || !this.localStream) return;
    let track = this.localStream.getAudioTracks().find(candidate => candidate.readyState === 'live');
    if (!track) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      track = stream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(oldTrack => { this.localStream?.removeTrack(oldTrack); oldTrack.stop(); });
      if (track) this.localStream.addTrack(track);
    }
    if (!track) return;
    track.enabled = this.audioEnabled;
    const sender = this.activeCall?.peerConnection.getSenders().find(candidate => candidate.track?.kind === 'audio' || candidate.track === null && candidate.getParameters().codecs?.some(codec => codec.mimeType.toLowerCase().startsWith('audio/')));
    if (sender && sender.track !== track) await sender.replaceTrack(track);
  }

  async toggleVideo(enabled: boolean) {
    if (!this.localStream) return this.localStream;
    this.videoEnabled = enabled;
    if (!enabled) {
      if (this.cameraTrack) this.cameraTrack.enabled = false;
      this.sendVideoState();
      return this.localStream;
    }

    if (!this.cameraTrack || this.cameraTrack.readyState === 'ended') {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: { ideal: 'user' },
        },
      });
      this.cameraTrack = cameraStream.getVideoTracks()[0];
    }
    if (!this.cameraTrack) throw new Error(t('تعذر تشغيل الكاميرا على هذا الجهاز.'));
    this.cameraTrack.enabled = true;
    if (this.videoSource === 'camera') {
      await this.replaceOutgoingVideoTrack(this.cameraTrack);
      this.replaceLocalPreviewTrack(this.cameraTrack);
    }
    this.sendVideoState();
    return this.localStream;
  }

  async startScreenShare() {
    if (!this.localStream) {
      throw new Error(t("ابدأ الجلسة قبل مشاركة الشاشة"));
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(t("مشاركة الشاشة غير مدعومة على هذا المتصفح أو نظام الهاتف"));
    }

    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const [screenTrack] = screenStream.getVideoTracks();
    if (!screenTrack) {
      throw new Error(t("لم يتم اختيار شاشة للمشاركة"));
    }

    this.screenTrack = screenTrack;
    this.videoSource = 'screen';
    await this.replaceOutgoingVideoTrack(screenTrack);
    this.replaceLocalPreviewTrack(screenTrack);
    this.callbacks.onLocalVideoSource('screen');
    this.sendVideoSource();
    this.callbacks.onStatus(t("مشاركة الشاشة تعمل الآن"));

    screenTrack.onended = () => {
      void this.stopScreenShare();
    };

    return this.localStream;
  }

  async stopScreenShare() {
    if (!this.localStream) return this.localStream;

    const screenTrack = this.screenTrack;
    this.screenTrack = undefined;
    this.videoSource = 'camera';
    const restoredTrack = this.videoEnabled ? this.cameraTrack : this.placeholderVideoTrack;
    await this.replaceOutgoingVideoTrack(restoredTrack);
    this.replaceLocalPreviewTrack(restoredTrack);
    this.callbacks.onLocalVideoSource('camera');
    this.sendVideoSource();
    this.callbacks.onStatus(this.hasRemoteStream ? t("الاتصال مباشر") : t("بانتظار دخول الطرف الثاني بنفس كود الغرفة"));
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
    this.cameraTrack?.stop();
    this.placeholderVideoTrack?.stop();
    this.localStream?.getTracks().forEach((track) => track.stop());
  }

  private async replaceOutgoingVideoTrack(track?: MediaStreamTrack) {
    const sender = this.activeCall?.peerConnection
      .getSenders()
      .find((candidate) => candidate.track?.kind === 'video');

    await sender?.replaceTrack(track ?? null);
  }

  private replaceLocalPreviewTrack(track?: MediaStreamTrack) {
    if (!this.localStream) return;

    this.localStream.getVideoTracks().forEach((oldTrack) => {
      this.localStream?.removeTrack(oldTrack);
    });
    if (track) this.localStream.addTrack(track);
  }

  private createPlaceholderVideoTrack() {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 9;
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
    const stream = typeof canvas.captureStream === 'function' ? canvas.captureStream(1) : undefined;
    const track = stream?.getVideoTracks()[0];
    if (track) track.enabled = false;
    return track;
  }

  private bindPeerEvents(peer: Peer) {
    if (!this.localStream) return;

    peer.on('open', (peerId) => {
      if (this.closed || this.peer !== peer) return;
      void this.callbacks.onLocalPeerId?.(peerId);
      this.callbacks.onStatus(t("بانتظار دخول الطرف الثاني بنفس كود الغرفة"));
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

      this.callbacks.onStatus(t("جاري قبول الاتصال"));
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
        this.callbacks.onStatus(t("تعذر إنشاء معرّف جديد للجلسة"));
        return;
      }

      if (error.type === 'peer-unavailable') {
        if (!this.hasRemoteStream) this.callbacks.onStatus(t("بانتظار دخول الطرف الثاني بنفس كود الغرفة"));
        return;
      }

      this.callbacks.onStatus(error.message || t("تعذر إنشاء الاتصال"));
    });

    peer.on('disconnected', () => {
      if (this.closed || this.peer !== peer) return;
      this.callbacks.onStatus(t("انقطع اتصال الإشارة، حاول بدء الجلسة مرة أخرى"));
      this.reconnectSignaling();
    });
  }

  private createPeer() {
    if (this.closed) return;
    const peer = new Peer({
      debug: 1,
      config: {
        iceServers: this.resolvedIceServers,
        iceCandidatePoolSize: 8,
      },
    });
    this.peer = peer;
    this.bindPeerEvents(peer);
  }

  reconnectSignaling() {
    if (!this.peer || this.peer.destroyed || !this.peer.disconnected) return;

    try {
      this.peer.reconnect();
      this.callbacks.onStatus(this.hasRemoteStream ? t("الاتصال مباشر") : t("جاري إعادة الاتصال"));
    } catch {
      this.callbacks.onStatus(t("تعذر إعادة الاتصال تلقائياً"));
    }
  }

  resumeAfterBackground() {
    this.reconnectSignaling();
    void this.repairAudio().catch(() => undefined);
    try { this.activeCall?.peerConnection.restartIce?.(); } catch { /* Some mobile WebViews do not expose restartIce. */ }

    if (!this.hasRemoteStream) {
      this.startPeerSearch();
    }
  }

  sendWhiteboard(message: unknown) {
    if (!this.activeDataConnection?.open) return false;
    this.activeDataConnection.send({ type: 'whiteboard', message });
    return true;
  }

  sendTyping(typing: boolean) {
    if (!this.activeDataConnection?.open) return false;
    this.activeDataConnection.send({ type: 'typing', typing });
    return true;
  }

  sendSpeaking(speaking: boolean) {
    if (!this.activeDataConnection?.open) return false;
    this.activeDataConnection.send({ type: 'speaking', speaking });
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
        if (!this.hasRemoteStream) this.callbacks.onStatus(t("جاري إعادة الاتصال"));
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

    this.callbacks.onStatus(t("جاري البحث عن الطالب"));
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
    this.bindIceDiagnostics(call);
    const callTimeout = window.setTimeout(() => {
      if (this.closed || this.hasRemoteStream || (!this.pendingCalls.has(call) && this.activeCall !== call)) return;
      this.callbacks.onStatus(hasTurnServer
        ? t('تعذر تمرير الصوت والفيديو عبر الشبكة. تحقق من الجدار الناري أو جرّب شبكة أخرى ثم أعد الاتصال.')
        : t('تعذر إنشاء مسار للصوت والفيديو بين الجهازين. يلزم إعداد خادم TURN للمكالمات عبر الشبكات المختلفة.'));
      this.pendingCalls.delete(call);
      if (this.activeCall === call) this.activeCall = undefined;
      call.close();
      this.startPeerSearch();
    }, 18000);
    this.callTimeouts.set(call, callTimeout);

    const acceptRemoteStream = (remoteStream: MediaStream) => {
      if (this.closed) {
        call.close();
        return;
      }
      const previousCall = this.activeCall;
      this.activeCall = call;
      this.hasRemoteStream = true;
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      this.pendingCalls.forEach(candidate => candidate.close());
      this.pendingCalls.clear();
      if (previousCall && previousCall !== call) previousCall.close();
      this.callbacks.onRemoteStream(remoteStream);
      this.callbacks.onStatus(t("الاتصال مباشر"));
      void this.repairAudio().catch(() => undefined);

      remoteStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => this.handleCallEnded(call), { once: true });
      });
    };

    call.on('stream', acceptRemoteStream);
    call.peerConnection.addEventListener('track', () => {
      const tracks = call.peerConnection.getReceivers().map(receiver => receiver.track).filter((track): track is MediaStreamTrack => Boolean(track && track.readyState === 'live'));
      if (tracks.length) acceptRemoteStream(new MediaStream(tracks));
    });

    call.on('close', () => {
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      this.handleCallEnded(call);
    });

    call.on('error', (error) => {
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      if (this.closed || this.activeCall !== call) return;
      this.hasRemoteStream = false;
      this.activeCall = undefined;
      this.callbacks.onPeerLeft();
      this.callbacks.onStatus(error.message || t("تعذر إكمال المكالمة"));
      this.startPeerSearch();
    });
  }

  private clearCallTimeout(call: MediaConnection) {
    const timer = this.callTimeouts.get(call);
    if (timer) window.clearTimeout(timer);
    this.callTimeouts.delete(call);
  }

  private bindIceDiagnostics(call: MediaConnection) {
    if (this.diagnosedCalls.has(call)) return;
    this.diagnosedCalls.add(call);
    const connection = call.peerConnection;
    let disconnectedTimer = 0;
    const recover = () => {
      if (this.closed || (this.activeCall !== call && !this.pendingCalls.has(call))) return;
      this.hasRemoteStream = false;
      if (this.activeCall === call) this.activeCall = undefined;
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      this.callbacks.onPeerLeft();
      call.close();
      this.startPeerSearch();
    };
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'connected') {
        if (disconnectedTimer) window.clearTimeout(disconnectedTimer);
        return;
      }
      if (connection.connectionState === 'disconnected') {
        this.callbacks.onStatus(t('انقطع مسار الصوت والفيديو مؤقتاً، جاري إعادة الاتصال…'));
        if (disconnectedTimer) window.clearTimeout(disconnectedTimer);
        disconnectedTimer = window.setTimeout(recover, document.visibilityState === 'hidden' ? 30000 : 12000);
      }
      if (connection.connectionState === 'failed') {
        if (disconnectedTimer) window.clearTimeout(disconnectedTimer);
        this.callbacks.onStatus(hasTurnServer
          ? t('فشل اتصال الوسائط. تحقق من الإنترنت أو الجدار الناري وسيُعاد الاتصال تلقائياً.')
          : t('فشل اتصال الوسائط بين الشبكتين لأن خادم TURN غير مفعّل.'));
        recover();
      }
    });
    connection.addEventListener('icecandidateerror', () => {
      if (!this.hasRemoteStream) this.callbacks.onStatus(hasTurnServer ? t('تعذر الوصول إلى خادم تمرير المكالمة. جاري المحاولة…') : t('جاري فحص مسار مباشر للصوت والفيديو…'));
    });
  }

  private handleCallEnded(call: MediaConnection) {
    // Closing a superseded call must not tear down the fresh replacement.
    if (this.closed || this.activeCall !== call) return;
    this.hasRemoteStream = false;
    this.activeCall = undefined;
    this.callbacks.onPeerLeft();
    this.callbacks.onStatus(t("غادر الطرف الآخر الجلسة، بانتظار عودته"));
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
      this.sendVideoState();
      this.callbacks.onDataOpen?.();
      // A fresh student data channel is an explicit presence handshake and
      // replaces any media connection that belongs to the previous session.
      if (this.role === 'teacher' && this.activeCall?.peer !== connection.peer) {
        this.remotePeerId = connection.peer;
        this.callStudent(connection.peer, true);
      }
    });

    connection.on('data', (message) => {
      if (isTypingMessage(message)) {
        this.callbacks.onRemoteTyping?.(message.typing);
        return;
      }
      if (isSpeakingMessage(message)) {
        this.callbacks.onRemoteSpeaking?.(message.speaking);
        return;
      }
      if (isVideoSourceMessage(message)) {
        this.callbacks.onRemoteVideoSource(message.source);
        return;
      }
      if (isVideoStateMessage(message)) {
        this.callbacks.onRemoteVideoEnabled?.(message.enabled);
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

  private sendVideoState() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'video-state', enabled: this.videoEnabled });
  }
}

function isTypingMessage(message: unknown): message is { type: 'typing'; typing: boolean } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; typing?: unknown };
  return candidate.type === 'typing' && typeof candidate.typing === 'boolean';
}

function isSpeakingMessage(message: unknown): message is { type: 'speaking'; speaking: boolean } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; speaking?: unknown };
  return candidate.type === 'speaking' && typeof candidate.speaking === 'boolean';
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

function isVideoStateMessage(message: unknown): message is { type: 'video-state'; enabled: boolean } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; enabled?: unknown };
  return candidate.type === 'video-state' && typeof candidate.enabled === 'boolean';
}
