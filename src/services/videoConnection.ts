import { t } from '../i18n/preferences';
import { request } from './platformApi';
import Peer, { DataConnection, MediaConnection } from 'peerjs';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteVideoSource: (source: VideoSource) => void;
  onRemoteVideoEnabled?: (enabled: boolean) => void;
  onRemoteAudioEnabled?: (enabled: boolean) => void;
  onWhiteboardMessage?: (message: unknown) => void;
  onRemoteTyping?: (typing: boolean) => void;
  onRemoteSpeaking?: (speaking: boolean) => void;
  onDataOpen?: () => void;
  onLocalPeerId?: (peerId: string | null) => void | Promise<void>;
  getRemotePeerId?: () => Promise<string | null | undefined>;
  initialRemotePeerId?: string | null;
  onRemotePresence?: (present: boolean) => void;
  onLocalVideoSource: (source: VideoSource) => void;
  onLocalScreenStream?: (stream: MediaStream | null) => void;
  onRemoteScreenStream?: (stream: MediaStream | null) => void;
  onLocalStreamChange?: (stream: MediaStream) => void;
  onRemoteProfile?: (profile: { name: string; avatar?: string } | null) => void;
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
const audioConstraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoConstraints: MediaTrackConstraints = {
  width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 },
  frameRate: { ideal: 24, max: 30 }, facingMode: { ideal: 'user' },
};
const leaveGraceMs = 750;
const mediaRetryDelays = [150, 300];

function isTransientCaptureError(cause: unknown) {
  const name = (cause as { name?: string } | null)?.name;
  return name === 'NotReadableError' || name === 'AbortError';
}

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
  private screenStream?: MediaStream;
  private outgoingScreenCall?: MediaConnection;
  private incomingScreenCall?: MediaConnection;
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
  private videoRepair?: Promise<void>;
  private audioRepair?: Promise<void>;
  private cameraAcquisition?: Promise<MediaStreamTrack | undefined>;
  private cameraFacing: 'user' | 'environment' = 'user';
  private cameraSwitch?: Promise<{ stream?: MediaStream; facing: 'user' | 'environment' }>;
  private startPromise?: Promise<MediaStream>;
  private generation = 0;
  private remoteStream?: MediaStream;
  private remotePresent = false;
  private profile?: { name: string; avatar?: string };
  private readonly handlePageHide = (event: PageTransitionEvent) => {
    // BFCache pages can resume; ordinary backgrounding/PiP uses visibilitychange.
    // Unload delivery is best-effort because the browser may stop networking.
    if (!event.persisted) this.close();
  };

  constructor(
    private readonly roomId: string,
    private readonly role: VideoRole,
    private readonly callbacks: PeerCallbacks,
  ) {}

  // Callers restoring an enabled camera can request both devices in one prompt.
  start(options: { video?: boolean } = {}): Promise<MediaStream> {
    if (this.startPromise) return this.startPromise;
    if (!this.closed && this.localStream) return Promise.resolve(this.localStream);
    this.closed = false;
    const generation = ++this.generation;
    const pending = this.startSession(generation, options.video === true).finally(() => {
      if (this.startPromise === pending) this.startPromise = undefined;
    });
    this.startPromise = pending;
    return pending;
  }

  private async startSession(generation: number, video: boolean) {
    const cleanRoomId = normalizeRoomId(this.roomId);
    if (!cleanRoomId) {
      throw new Error(t("اكتب رقم غرفة صحيح"));
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(t('الكاميرا والمايك يحتاجان متصفحاً حديثاً واتصال HTTPS.'));
    }

    this.callbacks.onStatus(t("جاري تشغيل المايك"));
    // Fetch traversal credentials while the browser prepares the microphone/camera.
    const iceReady = request<{ ice_servers?: RTCIceServer[] }>(`${this.role}s/video/ice`, undefined, undefined, 5000).then(result => {
      if (!this.closed && generation === this.generation && Array.isArray(result.ice_servers) && result.ice_servers.length) this.resolvedIceServers = result.ice_servers;
    }).catch(() => undefined);
    let stream: MediaStream | undefined;
    try {
      try {
        stream = await this.acquireUserMedia({ audio: audioConstraints, video: video ? { ...videoConstraints, facingMode: { ideal: this.cameraFacing } } : false }, generation);
      } catch (cause) {
        const name = (cause as { name?: string } | null)?.name;
        // Hardware/camera constraints must not block an otherwise usable mic.
        // Denials deliberately do not trigger another permission request.
        if (!video || !(isTransientCaptureError(cause) || name === 'NotFoundError' || name === 'OverconstrainedError')) throw cause;
        video = false;
        stream = await this.acquireUserMedia({ audio: audioConstraints, video: false }, generation);
      }
    } catch (cause) {
      if (this.closed || generation !== this.generation) throw new Error('Call closed');
      const error = cause as DOMException;
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        throw new Error(t('اسمح للمتصفح باستخدام المايك ثم حاول مجدداً.'));
      }
      throw new Error(t('تعذر تشغيل المايك على هذا الجهاز. أغلق أي تطبيق يستخدمه ثم حاول مجدداً.'));
    }
    if (!stream || this.closed || generation !== this.generation) { stream?.getTracks().forEach(track => track.stop()); throw new Error('Call closed'); }
    this.localStream = stream;
    window.addEventListener('pagehide', this.handlePageHide);
    this.videoEnabled = video;
    this.cameraTrack = stream.getVideoTracks()[0];
    stream.getAudioTracks().forEach(track => { track.enabled = this.audioEnabled; });
    if (!this.cameraTrack) {
      this.placeholderVideoTrack = this.createPlaceholderVideoTrack();
      if (this.placeholderVideoTrack) stream.addTrack(this.placeholderVideoTrack);
    }

    await iceReady;

    if (this.closed || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call closed'); }
    this.createPeer();
    return stream;
  }

  private async acquireUserMedia(constraints: MediaStreamConstraints, generation: number): Promise<MediaStream | undefined> {
    for (let attempt = 0; ; attempt++) {
      if (this.closed || generation !== this.generation) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (this.closed || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        return stream;
      } catch (cause) {
        if (this.closed || generation !== this.generation) return;
        if (!isTransientCaptureError(cause) || attempt >= mediaRetryDelays.length) throw cause;
        // Mobile device release can lag track.stop(). Bound automatic retries
        // to 450 ms per acquisition (900 ms including a mic-only fallback).
        await new Promise<void>(resolve => window.setTimeout(resolve, mediaRetryDelays[attempt]));
      }
    }
  }

  toggleAudio(enabled: boolean) {
    this.audioEnabled = enabled;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    if (enabled) void this.repairAudio().catch(() => undefined);
    this.sendAudioState();
  }

  async repairAudio() {
    if (this.closed || !this.localStream) return;
    if (this.audioRepair) return this.audioRepair;
    const localStream = this.localStream;
    const generation = this.generation;
    const pending = (async () => {
      let track = localStream.getAudioTracks().find(candidate => candidate.readyState === 'live');
      if (!track) {
        const stream = await this.acquireUserMedia({ audio: audioConstraints, video: false }, generation);
        if (!stream) return;
        if (this.closed || generation !== this.generation) { stream.getTracks().forEach(item => item.stop()); return; }
        track = stream.getAudioTracks()[0];
        localStream.getAudioTracks().forEach(oldTrack => { localStream.removeTrack(oldTrack); oldTrack.stop(); });
        if (track) localStream.addTrack(track);
      }
      if (!track) return;
      track.enabled = this.audioEnabled;
      const sender = this.activeCall?.peerConnection.getSenders().find(candidate => candidate.track?.kind === 'audio' || candidate.track === null && candidate.getParameters().codecs?.some(codec => codec.mimeType.toLowerCase().startsWith('audio/')));
      if (sender && sender.track !== track) await sender.replaceTrack(track);
    })().finally(() => { if (this.audioRepair === pending) this.audioRepair = undefined; });
    this.audioRepair = pending;
    return pending;
  }

  private acquireCamera(force = false) {
    if (this.cameraAcquisition) return this.cameraAcquisition;
    // Muting is often temporary on mobile; reuse a live track on a normal toggle.
    if (!force && this.cameraTrack?.readyState === 'live') return Promise.resolve(this.cameraTrack);
    const generation = this.generation;
    const pending = this.acquireUserMedia({ audio: false, video: { ...videoConstraints, facingMode: { ideal: this.cameraFacing } } }, generation).then(stream => {
      if (!stream) return;
      if (this.closed || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      const track = stream.getVideoTracks()[0];
      if (track) { this.cameraTrack?.stop(); this.cameraTrack = track; }
      return track;
    }).finally(() => { if (this.cameraAcquisition === pending) this.cameraAcquisition = undefined; });
    this.cameraAcquisition = pending;
    return pending;
  }

  async toggleVideo(enabled: boolean) {
    if (this.closed || !this.localStream) return this.localStream;
    this.videoEnabled = enabled;
    if (!enabled) {
      if (this.cameraTrack) this.cameraTrack.enabled = false;
      this.sendVideoState();
      return this.localStream;
    }

    const generation = this.generation;
    let track: MediaStreamTrack | undefined;
    try {
      track = await this.acquireCamera();
    } catch (cause) {
      if (!this.closed && generation === this.generation) {
        this.videoEnabled = Boolean(this.cameraTrack?.readyState === 'live' && this.cameraTrack.enabled);
        this.sendVideoState();
      }
      throw cause;
    }
    if (this.closed || generation !== this.generation) return this.localStream;
    if (!track) throw new Error(t('تعذر تشغيل الكاميرا على هذا الجهاز.'));
    track.enabled = this.videoEnabled;
    if (this.videoSource === 'camera') {
      await this.replaceOutgoingVideoTrack(track);
      if (this.closed || generation !== this.generation) return this.localStream;
      this.replaceLocalPreviewTrack(track);
    }
    this.sendVideoState();
    this.callbacks.onLocalStreamChange?.(this.localStream);
    return this.localStream;
  }

  getCameraFacing() { return this.cameraFacing; }

  switchCamera() {
    if (this.cameraSwitch) return this.cameraSwitch;
    const generation = this.generation;
    const pending = (async () => {
      await this.cameraAcquisition;
      if (this.closed || generation !== this.generation || !this.localStream || !this.videoEnabled || this.videoSource !== 'camera') return { stream: this.localStream, facing: this.cameraFacing };
      const previous = this.cameraFacing;
      this.cameraFacing = previous === 'user' ? 'environment' : 'user';
      // Mobile devices often cannot keep front and rear cameras active together.
      // Release only video; microphone and the existing call stay connected.
      this.cameraTrack?.stop(); this.cameraTrack = undefined;
      try {
        const stream = await this.toggleVideo(true);
        const actual = stream?.getVideoTracks()[0]?.getSettings?.().facingMode;
        if (actual === 'user' || actual === 'environment') this.cameraFacing = actual;
        return { stream, facing: this.cameraFacing };
      } catch (error) {
        this.cameraFacing = previous;
        if (!this.closed && generation === this.generation) {
          try { await this.toggleVideo(true); } catch { /* Audio continues if both cameras fail. */ }
        }
        throw error;
      }
    })().finally(() => { if (this.cameraSwitch === pending) this.cameraSwitch = undefined; });
    this.cameraSwitch = pending;
    return pending;
  }

  async repairVideo(force = false) {
    if (this.cameraSwitch) return;
    if (this.closed || !this.localStream || !this.videoEnabled || this.videoSource !== 'camera') return;
    if (this.videoRepair) return this.videoRepair;
    const current = this.cameraTrack;
    if (!force && current?.readyState === 'live' && !current.muted) return;
    const generation = this.generation;
    const pending = (async () => {
      const track = await this.acquireCamera(true);
      if (this.closed || generation !== this.generation || !track) return;
      track.enabled = this.videoEnabled;
      if (!this.videoEnabled || this.videoSource !== 'camera') return;
      await this.replaceOutgoingVideoTrack(track);
      if (this.closed || generation !== this.generation) return;
      this.replaceLocalPreviewTrack(track);
      this.sendVideoState();
      this.callbacks.onLocalStreamChange?.(this.localStream!);
    })().finally(() => { if (this.videoRepair === pending) this.videoRepair = undefined; });
    this.videoRepair = pending;
    return pending;
  }

  async startScreenShare() {
    if (this.closed || !this.localStream) {
      throw new Error(t("ابدأ الجلسة قبل مشاركة الشاشة"));
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(t("مشاركة الشاشة غير مدعومة على هذا المتصفح أو نظام الهاتف"));
    }

    const generation = this.generation;
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (this.closed || generation !== this.generation) { screenStream.getTracks().forEach(track => track.stop()); throw new Error('Call closed'); }
    const [screenTrack] = screenStream.getVideoTracks();
    if (!screenTrack) {
      throw new Error(t("لم يتم اختيار شاشة للمشاركة"));
    }

    this.screenTrack = screenTrack;
    this.screenStream = screenStream;
    this.callbacks.onLocalScreenStream?.(screenStream);
    this.callbacks.onLocalVideoSource('screen');
    this.activeDataConnection?.open && this.activeDataConnection.send({ type: 'screen-state', enabled: true });
    this.connectScreenShare();
    this.callbacks.onStatus(t("مشاركة الشاشة تعمل الآن"));

    screenTrack.onended = () => {
      if (this.screenTrack === screenTrack) void this.stopScreenShare();
    };

    return screenStream;
  }

  async stopScreenShare() {
    if (!this.localStream) return this.localStream;

    const screenTrack = this.screenTrack;
    this.screenTrack = undefined;
    this.screenStream = undefined;
    this.outgoingScreenCall?.close(); this.outgoingScreenCall = undefined;
    this.callbacks.onLocalScreenStream?.(null);
    this.activeDataConnection?.open && this.activeDataConnection.send({ type: 'screen-state', enabled: false });
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
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('pagehide', this.handlePageHide);
    ++this.generation;
    this.startPromise = undefined;
    this.audioRepair = undefined;
    this.videoRepair = undefined;
    this.cameraAcquisition = undefined;
    this.discoveryInFlight = false;
    if (this.retryTimer) window.clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    void this.callbacks.onLocalPeerId?.(null);

    // Keep the captured data transport alive until delivery is acknowledged (or
    // a short deadline). PeerJS close/destroy immediately discards its buffers.
    const peer = this.peer;
    const data = this.activeDataConnection;
    this.peer = undefined;
    this.activeDataConnection = undefined;
    const finish = () => { data?.close(); peer?.destroy(); };
    if (data?.open) {
      let finished = false;
      const timer = window.setTimeout(finishLeave, leaveGraceMs);
      function finishLeave() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        data!.off('data', acknowledge);
        data!.off('close', finishLeave);
        finish();
      }
      const acknowledge = (message: unknown) => {
        if (message && typeof message === 'object' && (message as { type?: string }).type === 'peer-leave-ack') finishLeave();
      };
      data.on('data', acknowledge);
      data.on('close', finishLeave);
      try { void Promise.resolve(data.send({ type: 'peer-leave' })).catch(finishLeave); } catch { finishLeave(); }
    } else {
      finish();
    }
    this.closeRemoteMedia();
    this.remotePresent = false;
    const pendingData = [...this.pendingDataConnections];
    this.pendingDataConnections.clear();
    pendingData.forEach(connection => connection.close());
    this.screenStream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.screenTrack?.stop();
    this.cameraTrack?.stop();
    this.placeholderVideoTrack?.stop();
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
    this.cameraTrack = this.placeholderVideoTrack = this.screenTrack = undefined;
    this.screenStream = undefined;
  }

  private closeRemoteMedia() {
    const calls = new Set([...this.pendingCalls, this.activeCall, this.incomingScreenCall, this.outgoingScreenCall]);
    this.pendingCalls.clear();
    this.activeCall = this.incomingScreenCall = this.outgoingScreenCall = undefined;
    this.hasRemoteStream = false;
    const stream = this.remoteStream;
    this.remoteStream = undefined;
    calls.forEach(call => { if (call) { this.clearCallTimeout(call); call.close(); } });
    stream?.getTracks().forEach(track => track.stop());
  }

  private clearRemoteParticipant() {
    const wasPresent = this.remotePresent;
    this.remotePresent = false;
    this.closeRemoteMedia();
    if (!wasPresent || this.closed) return;
    this.callbacks.onRemoteScreenStream?.(null);
    this.callbacks.onRemoteTyping?.(false);
    this.callbacks.onRemoteSpeaking?.(false);
    this.callbacks.onRemoteProfile?.(null);
    this.callbacks.onRemoteVideoEnabled?.(false);
    this.callbacks.onRemoteAudioEnabled?.(false);
    this.callbacks.onRemoteVideoSource('camera');
    this.callbacks.onPeerLeft();
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
      const target = !this.remotePeerId && !this.hasRemoteStream ? this.callbacks.initialRemotePeerId : null;
      if (target) {
        this.remotePeerId = target;
        this.callbacks.onRemotePresence?.(true);
        if (this.role === 'teacher') this.callStudent(target); else this.ensureStudentDataConnection(target);
      } else this.callbacks.onStatus(t('جارٍ التحقق من حضور الطرف الآخر'));
      this.startPeerSearch();
    });

    peer.on('call', (call) => {
      if (this.closed || this.peer !== peer) {
        call.close();
        return;
      }
      if (call.metadata?.kind === 'screen') {
        const expectedPeer = this.activeDataConnection?.peer || this.activeCall?.peer;
        if (!expectedPeer || call.peer !== expectedPeer) { call.close(); return; }
        const previous = this.incomingScreenCall; this.incomingScreenCall = call; previous?.close();
        call.on('stream', stream => { if (!this.closed && this.incomingScreenCall === call) this.callbacks.onRemoteScreenStream?.(stream); });
        const ended = () => { if (this.incomingScreenCall === call) { this.incomingScreenCall = undefined; this.callbacks.onRemoteScreenStream?.(null); } };
        call.on('close', ended); call.on('error', ended); call.answer();
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

      const peerChanged = this.remotePeerId !== call.peer;
      if (peerChanged) {
        const previous = this.activeDataConnection;
        this.activeDataConnection = undefined;
        this.clearRemoteParticipant();
        previous?.close();
      }
      this.remotePeerId = call.peer;
      this.callbacks.onStatus(t("جاري قبول الاتصال"));
      // Incoming PeerJS calls create peerConnection inside answer(). Binding
      // ICE/track listeners before answering dereferences an absent transport.
      call.answer(this.localStream!);
      this.bindCallEvents(call);
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
    if (this.closed || !this.peer || this.peer.destroyed || !this.peer.disconnected) return;

    try {
      this.peer.reconnect();
      this.callbacks.onStatus(this.hasRemoteStream ? t("الاتصال مباشر") : t("جاري إعادة الاتصال"));
    } catch {
      this.callbacks.onStatus(t("تعذر إعادة الاتصال تلقائياً"));
    }
  }

  resumeAfterBackground() {
    if (this.closed) return;
    this.reconnectSignaling();
    void this.repairAudio().catch(() => undefined);
    void this.repairVideo().catch(() => this.callbacks.onStatus(t('تعذر استعادة الكاميرا. اضغط زر الكاميرا لإعادة تشغيلها.')));
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
    this.activeDataConnection.send({ type: 'speaking', speaking: speaking && this.audioEnabled });
    return true;
  }

  sendProfile(profile: { name: string; avatar?: string }) {
    this.profile = profile;
    if (this.activeDataConnection?.open) this.activeDataConnection.send({ type: 'profile', profile });
  }

  private startPeerSearch() {
    if (this.closed) return;
    if (this.retryTimer) window.clearInterval(this.retryTimer);

    const generation = this.generation;
    const findOtherPeer = async () => {
      if (this.closed || generation !== this.generation || this.discoveryInFlight || !this.callbacks.getRemotePeerId) return;
      this.discoveryInFlight = true;
      const dataAtDiscovery = this.activeDataConnection;
      const callAtDiscovery = this.activeCall;
      const peerAtDiscovery = this.remotePeerId;
      try {
        const discoveredPeerId = await this.callbacks.getRemotePeerId();
        if (this.closed || generation !== this.generation) return;
        // A presence response started before a new handshake must not replace
        // the peer that has since connected directly.
        if (dataAtDiscovery !== this.activeDataConnection || callAtDiscovery !== this.activeCall || peerAtDiscovery !== this.remotePeerId) return;
        if (!discoveredPeerId) {
          if (!this.hasRemoteStream && !this.activeDataConnection?.open) this.callbacks.onRemotePresence?.(false);
          return;
        }
        this.callbacks.onRemotePresence?.(true);
        const peerChanged = discoveredPeerId !== this.remotePeerId;
        this.remotePeerId = discoveredPeerId;
        if (this.role === 'teacher') {
          this.callStudent(discoveredPeerId, peerChanged);
        } else {
          this.ensureStudentDataConnection(discoveredPeerId, peerChanged);
        }
      } catch {
        if (!this.closed && generation === this.generation && !this.hasRemoteStream) this.callbacks.onStatus(t("جاري إعادة الاتصال"));
      } finally {
        if (generation === this.generation) this.discoveryInFlight = false;
      }
    };

    void findOtherPeer();
    this.retryTimer = window.setInterval(() => void findOtherPeer(), 1500);
  }

  private callStudent(targetPeerId: string, replaceStaleCall = false) {
    if (this.closed || this.role !== 'teacher' || !this.peer?.open || !this.localStream) return;
    if (!replaceStaleCall && (this.activeCall || this.hasRemoteStream || this.pendingCalls.size)) return;

    if (replaceStaleCall) {
      if (this.activeDataConnection && this.activeDataConnection.peer !== targetPeerId) {
        const staleData = this.activeDataConnection;
        this.activeDataConnection = undefined;
        this.clearRemoteParticipant();
        staleData.close();
      }
      if (this.activeCall || this.hasRemoteStream) this.clearRemoteParticipant();
      else this.closeRemoteMedia();
    }

    this.callbacks.onStatus(t('جارٍ الاتصال بالطرف الموجود في الغرفة'));
    this.bindCallEvents(this.peer.call(targetPeerId, this.localStream));
  }

  private ensureStudentDataConnection(targetPeerId: string, replaceStaleConnection = false) {
    if (this.closed || this.role !== 'student' || !this.peer?.open) return;
    if (!replaceStaleConnection && (this.activeDataConnection?.open || this.pendingDataConnections.size)) return;
    if (replaceStaleConnection) {
      const staleData = this.activeDataConnection;
      this.activeDataConnection = undefined;
      if ((staleData && staleData.peer !== targetPeerId) || (this.activeCall && this.activeCall.peer !== targetPeerId)) this.clearRemoteParticipant();
      staleData?.close();
      const pending = [...this.pendingDataConnections];
      this.pendingDataConnections.clear();
      pending.forEach(connection => connection.close());
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
      if (this.activeCall !== call && !this.pendingCalls.has(call)) return;
      const previousCall = this.activeCall;
      this.activeCall = call;
      this.hasRemoteStream = true;
      this.remotePresent = true;
      this.remoteStream = remoteStream;
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      const pending = [...this.pendingCalls];
      this.pendingCalls.clear();
      pending.forEach(candidate => { this.clearCallTimeout(candidate); candidate.close(); });
      if (previousCall && previousCall !== call) previousCall.close();
      this.callbacks.onRemoteStream(remoteStream);
      // Media and data may reconnect in either order. Re-request flags after the
      // new media session is accepted so a late peer-left event cannot leave a
      // live camera hidden behind the old "camera off" state.
      if (this.activeDataConnection?.open && this.activeDataConnection.peer === call.peer) {
        this.sendCurrentState();
        this.activeDataConnection.send({ type: 'state-request' });
      }
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
      this.clearRemoteParticipant();
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
    call.on('close', () => { if (disconnectedTimer) window.clearTimeout(disconnectedTimer); });
    const recover = () => {
      if (this.closed || (this.activeCall !== call && !this.pendingCalls.has(call))) return;
      if (this.activeCall === call) this.clearRemoteParticipant();
      this.pendingCalls.delete(call);
      this.clearCallTimeout(call);
      call.close();
      this.startPeerSearch();
    };
    connection.addEventListener('connectionstatechange', () => {
      if (this.closed || (this.activeCall !== call && !this.pendingCalls.has(call))) {
        if (disconnectedTimer) window.clearTimeout(disconnectedTimer);
        return;
      }
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
      if (this.closed || (this.activeCall !== call && !this.pendingCalls.has(call))) return;
      if (!this.hasRemoteStream) this.callbacks.onStatus(hasTurnServer ? t('تعذر الوصول إلى خادم تمرير المكالمة. جاري المحاولة…') : t('جاري فحص مسار مباشر للصوت والفيديو…'));
    });
  }

  private handleCallEnded(call: MediaConnection) {
    // Closing a superseded call must not tear down the fresh replacement.
    if (this.closed || this.activeCall !== call) return;
    this.clearRemoteParticipant();
    this.callbacks.onStatus(t("غادر الطرف الآخر الجلسة، بانتظار عودته"));
    this.startPeerSearch();
  }

  private bindDataConnection(connection: DataConnection) {
    this.pendingDataConnections.add(connection);

    connection.on('open', async () => {
      if (this.closed || !this.pendingDataConnections.has(connection)) {
        connection.close();
        return;
      }
      const previous = this.activeDataConnection;
      if (previous?.open && previous !== connection) {
        if (previous.peer === connection.peer) {
          this.pendingDataConnections.delete(connection); connection.close(); return;
        }
        const expected = await this.callbacks.getRemotePeerId?.().catch(() => null);
        if (this.closed || !this.pendingDataConnections.has(connection) || !connection.open || this.activeDataConnection !== previous || (expected && expected !== connection.peer)) {
          this.pendingDataConnections.delete(connection); connection.close(); return;
        }
      }
      this.activeDataConnection = undefined;
      if ((previous && previous !== connection) || (this.activeCall && this.activeCall.peer !== connection.peer)) this.clearRemoteParticipant();
      previous?.close();
      this.activeDataConnection = connection;
      this.remotePeerId = connection.peer;
      this.remotePresent = true;
      this.pendingDataConnections.delete(connection);
      const pending = [...this.pendingDataConnections];
      this.pendingDataConnections.clear();
      pending.forEach(candidate => candidate.close());
      this.sendCurrentState();
      this.callbacks.onDataOpen?.();
      connection.send({ type: 'state-request' });
      // A fresh student data channel is an explicit presence handshake and
      // replaces any media connection that belongs to the previous session.
      if (this.role === 'teacher' && this.activeCall?.peer !== connection.peer) {
        this.remotePeerId = connection.peer;
        this.callStudent(connection.peer, true);
      }
    });

    connection.on('data', (message) => {
      if (this.closed || this.activeDataConnection !== connection) return;
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'peer-leave') {
        // Acknowledge before retiring the channel; flush preserves message order.
        try { void Promise.resolve(connection.send({ type: 'peer-leave-ack' })).catch(() => undefined); } catch { /* Already disconnected. */ }
        this.activeDataConnection = undefined;
        this.clearRemoteParticipant();
        try { connection.close({ flush: true }); } catch { connection.close(); }
        window.setTimeout(() => connection.close(), leaveGraceMs);
        this.callbacks.onStatus(t("غادر الطرف الآخر الجلسة، بانتظار عودته"));
        this.startPeerSearch();
        return;
      }
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'screen-state') {
        if ((message as { enabled?: boolean }).enabled === false) {
          const incoming = this.incomingScreenCall; this.incomingScreenCall = undefined; incoming?.close(); this.callbacks.onRemoteScreenStream?.(null);
        }
        return;
      }
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'state-request') {
        this.sendCurrentState();
        this.callbacks.onDataOpen?.();
        return;
      }
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'profile') {
        const profile = (message as { profile?: { name?: unknown; avatar?: unknown } }).profile;
        if (typeof profile?.name === 'string') this.callbacks.onRemoteProfile?.({ name: profile.name.slice(0, 120), avatar: typeof profile.avatar === 'string' && /^\/api\/media\/avatar\//.test(profile.avatar) ? profile.avatar : undefined });
        return;
      }
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
      if (isAudioStateMessage(message)) {
        this.callbacks.onRemoteAudioEnabled?.(message.enabled);
        return;
      }
      if (isWhiteboardMessage(message)) this.callbacks.onWhiteboardMessage?.(message.message);
    });

    const ended = () => {
      this.pendingDataConnections.delete(connection);
      if (this.closed || this.activeDataConnection !== connection) return;
      this.activeDataConnection = undefined;
      connection.close();
      this.clearRemoteParticipant();
      this.callbacks.onStatus(t("غادر الطرف الآخر الجلسة، بانتظار عودته"));
      this.startPeerSearch();
    };
    connection.on('close', ended);
    connection.on('error', ended);
  }

  private sendVideoSource() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'video-source', source: this.videoSource });
  }

  private sendCurrentState() {
    this.sendVideoSource(); this.sendVideoState(); this.sendAudioState();
    if (this.activeDataConnection?.open) this.activeDataConnection.send({ type: 'screen-state', enabled: Boolean(this.screenStream) });
    if (this.profile) this.sendProfile(this.profile);
    this.connectScreenShare();
  }

  private connectScreenShare() {
    const target = this.activeDataConnection?.peer || this.remotePeerId;
    if (this.closed || !this.screenStream || !this.peer?.open || !target) return;
    if (this.outgoingScreenCall?.peer === target && this.outgoingScreenCall.open) return;
    if (this.outgoingScreenCall?.peer === target) return;
    const previous = this.outgoingScreenCall; this.outgoingScreenCall = undefined; previous?.close();
    const call = this.peer.call(target, this.screenStream, { metadata: { kind: 'screen' } });
    this.outgoingScreenCall = call;
    const ended = () => { if (this.outgoingScreenCall === call) this.outgoingScreenCall = undefined; };
    call.on('close', ended); call.on('error', ended);
  }

  private sendVideoState() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'video-state', enabled: this.videoEnabled });
  }

  private sendAudioState() {
    if (!this.activeDataConnection?.open) return;
    this.activeDataConnection.send({ type: 'audio-state', enabled: this.audioEnabled });
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

function isAudioStateMessage(message: unknown): message is { type: 'audio-state'; enabled: boolean } {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; enabled?: unknown };
  return candidate.type === 'audio-state' && typeof candidate.enabled === 'boolean';
}
