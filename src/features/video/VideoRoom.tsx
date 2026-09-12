import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Mic, MicOff, PhoneOff, RadioTower } from 'lucide-react';
import { VideoConnection, VideoRole } from '../../services/videoConnection';

export function VideoRoom() {
  const [role, setRole] = useState<VideoRole>('teacher');
  const [roomId, setRoomId] = useState('mansah-demo-room');
  const [status, setStatus] = useState('جاهز لبدء الجلسة');
  const [isConnected, setIsConnected] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<VideoConnection | null>(null);

  useEffect(() => {
    return () => {
      connectionRef.current?.close();
    };
  }, []);

  const startCall = async () => {
    try {
      connectionRef.current?.close();
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

      const connection = new VideoConnection(roomId.trim(), role, {
        onRemoteStream: (stream) => {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
          setStatus('الاتصال مباشر');
        },
        onPeerLeft: () => {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        },
        onStatus: setStatus,
      });

      connectionRef.current = connection;
      const localStream = await connection.start();
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
      setIsConnected(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر بدء المكالمة';
      setStatus(message);
      setIsConnected(false);
    }
  };

  const endCall = () => {
    connectionRef.current?.close();
    connectionRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setIsConnected(false);
    setStatus('تم إنهاء الجلسة');
  };

  const handleAudioToggle = () => {
    const nextValue = !audioEnabled;
    setAudioEnabled(nextValue);
    connectionRef.current?.toggleAudio(nextValue);
  };

  const handleVideoToggle = () => {
    const nextValue = !videoEnabled;
    setVideoEnabled(nextValue);
    connectionRef.current?.toggleVideo(nextValue);
  };

  return (
    <section className="video-room">
      <div className="video-header">
        <div>
          <span className="eyebrow">WebRTC Live Session</span>
          <h2>غرفة مكالمة الأستاذ والطالب</h2>
          <p>افتح الرابط على جهازين. ابدأ كأستاذ أولاً، ثم افتح الجهاز الثاني كطالب بنفس رقم الغرفة.</p>
        </div>
        <div className="status-pill">
          <RadioTower size={17} />
          {status}
        </div>
      </div>

      <div className="session-controls">
        <label>
          نوع الدخول
          <select value={role} onChange={(event) => setRole(event.target.value as VideoRole)}>
            <option value="teacher">أستاذ</option>
            <option value="student">طالب</option>
          </select>
        </label>
        <label>
          رقم الغرفة
          <input value={roomId} onChange={(event) => setRoomId(event.target.value)} />
        </label>
        <button className="primary-button" type="button" onClick={startCall}>
          <Camera size={18} />
          بدء الجلسة
        </button>
      </div>

      <div className="video-grid">
        <article className="video-panel remote">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <div className="video-label">الطرف الآخر</div>
        </article>
        <article className="video-panel local">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <div className="video-label">{role === 'teacher' ? 'الأستاذ' : 'الطالب'}</div>
        </article>
      </div>

      <div className="call-toolbar" aria-label="أدوات المكالمة">
        <button
          className={audioEnabled ? 'tool-button' : 'tool-button muted'}
          disabled={!isConnected}
          onClick={handleAudioToggle}
          title={audioEnabled ? 'إيقاف المايك' : 'تشغيل المايك'}
          type="button"
        >
          {audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}
        </button>
        <button
          className={videoEnabled ? 'tool-button' : 'tool-button muted'}
          disabled={!isConnected}
          onClick={handleVideoToggle}
          title={videoEnabled ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا'}
          type="button"
        >
          {videoEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
        </button>
        <button className="tool-button danger" disabled={!isConnected} onClick={endCall} title="إنهاء المكالمة" type="button">
          <PhoneOff size={20} />
        </button>
      </div>
    </section>
  );
}
