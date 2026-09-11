import { io, Socket } from 'socket.io-client';

type PeerCallbacks = {
  onRemoteStream: (stream: MediaStream) => void;
  onPeerLeft: () => void;
  onStatus: (status: string) => void;
};

export type VideoRole = 'teacher' | 'student';

const rtcConfiguration: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

export class VideoConnection {
  private socket?: Socket;
  private peer?: RTCPeerConnection;
  private localStream?: MediaStream;

  constructor(
    private readonly roomId: string,
    private readonly role: VideoRole,
    private readonly callbacks: PeerCallbacks,
  ) {}

  async start() {
    this.callbacks.onStatus('جاري تشغيل الكاميرا والمايك');
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
      },
    });

    this.peer = new RTCPeerConnection(rtcConfiguration);
    this.localStream.getTracks().forEach((track) => {
      this.peer?.addTrack(track, this.localStream!);
    });

    this.peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) this.callbacks.onRemoteStream(remoteStream);
    };

    this.socket = io('/', { transports: ['websocket'] });
    this.bindSocketEvents();

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket?.emit('webrtc:ice-candidate', {
          roomId: this.roomId,
          candidate: event.candidate,
        });
      }
    };

    this.socket.emit('room:join', { roomId: this.roomId, role: this.role });
    this.callbacks.onStatus('بانتظار الطرف الثاني');

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
    this.socket?.disconnect();
    this.peer?.close();
    this.localStream?.getTracks().forEach((track) => track.stop());
  }

  private bindSocketEvents() {
    this.socket?.on('peer:joined', async () => {
      if (!this.peer || this.role !== 'teacher') return;

      this.callbacks.onStatus('جاري إنشاء الاتصال');
      const offer = await this.peer.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await this.peer.setLocalDescription(offer);
      this.socket?.emit('webrtc:offer', { roomId: this.roomId, offer });
    });

    this.socket?.on('webrtc:offer', async ({ offer }) => {
      if (!this.peer) return;

      this.callbacks.onStatus('جاري قبول الاتصال');
      await this.peer.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      this.socket?.emit('webrtc:answer', { roomId: this.roomId, answer });
    });

    this.socket?.on('webrtc:answer', async ({ answer }) => {
      if (!this.peer) return;

      await this.peer.setRemoteDescription(new RTCSessionDescription(answer));
      this.callbacks.onStatus('الاتصال مباشر');
    });

    this.socket?.on('webrtc:ice-candidate', async ({ candidate }) => {
      if (!this.peer || !candidate) return;
      await this.peer.addIceCandidate(new RTCIceCandidate(candidate));
    });

    this.socket?.on('peer:left', () => {
      this.callbacks.onPeerLeft();
      this.callbacks.onStatus('غادر الطرف الآخر الجلسة');
    });
  }
}
