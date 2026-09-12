import Peer, { MediaConnection } from 'peerjs';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onPeerLeft: () => void;
  onStatus: (status: string) => void;
};

export type VideoRole = 'teacher' | 'student';

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
  private localStream?: MediaStream;

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

  close() {
    this.activeCall?.close();
    this.peer?.destroy();
    this.localStream?.getTracks().forEach((track) => track.stop());
  }

  private bindPeerEvents(cleanRoomId: string) {
    if (!this.peer || !this.localStream) return;

    this.peer.on('open', () => {
      if (this.role === 'teacher') {
        this.callbacks.onStatus('الأستاذ جاهز، افتح الطالب بنفس كود الغرفة');
        return;
      }

      this.callbacks.onStatus('جاري الاتصال بالأستاذ');
      const call = this.peer?.call(getPeerId(cleanRoomId, 'teacher'), this.localStream!);
      if (call) this.bindCallEvents(call);
    });

    this.peer.on('call', (call) => {
      this.callbacks.onStatus('جاري قبول اتصال الطالب');
      call.answer(this.localStream);
      this.bindCallEvents(call);
    });

    this.peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        this.callbacks.onStatus('هذا الدور مفتوح حالياً في نفس الغرفة');
        return;
      }

      if (error.type === 'peer-unavailable') {
        this.callbacks.onStatus('افتح الأستاذ أولاً ثم افتح الطالب بنفس كود الغرفة');
        return;
      }

      this.callbacks.onStatus(error.message || 'تعذر إنشاء الاتصال');
    });

    this.peer.on('disconnected', () => {
      this.callbacks.onStatus('انقطع اتصال الإشارة، حاول بدء الجلسة مرة أخرى');
    });
  }

  private bindCallEvents(call: MediaConnection) {
    this.activeCall?.close();
    this.activeCall = call;

    call.on('stream', (remoteStream) => {
      this.callbacks.onRemoteStream(remoteStream);
      this.callbacks.onStatus('الاتصال مباشر');
    });

    call.on('close', () => {
      this.callbacks.onPeerLeft();
      this.callbacks.onStatus('غادر الطرف الآخر الجلسة');
    });

    call.on('error', (error) => {
      this.callbacks.onStatus(error.message || 'تعذر إكمال المكالمة');
    });
  }
}
