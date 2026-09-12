import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Download, Mic, MicOff, PhoneOff, PictureInPicture2, RadioTower, ScreenShare, ScreenShareOff } from 'lucide-react';
import { VideoConnection, VideoRole, VideoSource } from '../../services/videoConnection';

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

declare global {
  interface Window {
    mansahCallActive?: boolean;
  }
}

export function VideoRoom() {
  const [role, setRole] = useState<VideoRole>('teacher');
  const [roomId, setRoomId] = useState('mansah-demo-room');
  const [status, setStatus] = useState('جاهز لبدء الجلسة');
  const [isConnected, setIsConnected] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [remoteVideoSource, setRemoteVideoSource] = useState<VideoSource>('camera');
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<VideoConnection | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    return () => {
      window.mansahCallActive = false;
      void wakeLockRef.current?.release();
      connectionRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    window.mansahCallActive = isConnected;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isConnected) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isConnected]);

  useEffect(() => {
    const handleEnterPictureInPicture = () => setIsPictureInPicture(true);
    const handleLeavePictureInPicture = () => setIsPictureInPicture(false);

    const localVideo = localVideoRef.current;
    const remoteVideo = remoteVideoRef.current;

    localVideo?.addEventListener('enterpictureinpicture', handleEnterPictureInPicture);
    localVideo?.addEventListener('leavepictureinpicture', handleLeavePictureInPicture);
    remoteVideo?.addEventListener('enterpictureinpicture', handleEnterPictureInPicture);
    remoteVideo?.addEventListener('leavepictureinpicture', handleLeavePictureInPicture);

    return () => {
      localVideo?.removeEventListener('enterpictureinpicture', handleEnterPictureInPicture);
      localVideo?.removeEventListener('leavepictureinpicture', handleLeavePictureInPicture);
      remoteVideo?.removeEventListener('enterpictureinpicture', handleEnterPictureInPicture);
      remoteVideo?.removeEventListener('leavepictureinpicture', handleLeavePictureInPicture);
    };
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) {
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
      return;
    }

    const requestWakeLock = async () => {
      try {
        const wakeLock = (navigator as WakeLockNavigator).wakeLock;
        if (!wakeLock || document.visibilityState !== 'visible') return;

        wakeLockRef.current = await wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      } catch {
        wakeLockRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void requestWakeLock();
      connectionRef.current?.resumeAfterBackground();
    };

    void requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
    };
  }, [isConnected]);

  const startCall = async () => {
    try {
      connectionRef.current?.close();
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      setIsScreenSharing(false);
      setRemoteVideoSource('camera');

      const connection = new VideoConnection(roomId.trim(), role, {
        onRemoteStream: (stream) => {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
          setStatus('الاتصال مباشر');
        },
        onRemoteVideoSource: setRemoteVideoSource,
        onLocalVideoSource: (source) => {
          setIsScreenSharing(source === 'screen');
        },
        onPeerLeft: () => {
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteVideoSource('camera');
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
    setIsScreenSharing(false);
    setIsPictureInPicture(false);
    setRemoteVideoSource('camera');
    setStatus('تم إنهاء الجلسة');
    window.mansahCallActive = false;
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

  const handleScreenShareToggle = async () => {
    try {
      if (!connectionRef.current) return;

      if (isScreenSharing) {
        const cameraStream = await connectionRef.current.stopScreenShare();
        if (localVideoRef.current && cameraStream) localVideoRef.current.srcObject = cameraStream;
        setIsScreenSharing(false);
        return;
      }

      const screenStream = await connectionRef.current.startScreenShare();
      if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
      setIsScreenSharing(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر مشاركة الشاشة';
      setStatus(message);
      setIsScreenSharing(false);
    }
  };

  const handlePictureInPictureToggle = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPictureInPicture(false);
        return;
      }

      const targetVideo = remoteVideoRef.current?.srcObject ? remoteVideoRef.current : localVideoRef.current;
      if (!targetVideo || !targetVideo.srcObject) {
        setStatus('ابدأ الجلسة قبل فتح النافذة العائمة');
        return;
      }

      if (!document.pictureInPictureEnabled || !targetVideo.requestPictureInPicture) {
        setStatus('النافذة العائمة غير مدعومة على هذا المتصفح');
        return;
      }

      await targetVideo.play();
      await targetVideo.requestPictureInPicture();
      setIsPictureInPicture(true);
      setStatus('النافذة العائمة تعمل الآن');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر فتح النافذة العائمة';
      setStatus(message);
      setIsPictureInPicture(false);
    }
  };

  const handleInstallApp = async () => {
    if (!installPrompt) return;

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      setInstallPrompt(null);
      setStatus('تم تثبيت المنصة كتطبيق');
    }
  };

  return (
    <section className="video-room">
      <div className="video-header">
        <div>
          <span className="eyebrow">WebRTC Live Session</span>
          <h2>غرفة مكالمة الأستاذ والطالب</h2>
          <p>افتح الرابط على جهازين بنفس رقم الغرفة. لا يهم من يبدأ أولاً، الاتصال يكتمل عندما يدخل الطرفان.</p>
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
          <video ref={remoteVideoRef} autoPlay playsInline className={remoteVideoSource === 'camera' ? 'mirrored-video' : undefined} />
          <div className="video-label">الطرف الآخر</div>
        </article>
        <article className="video-panel local">
          <video ref={localVideoRef} autoPlay muted playsInline className={isScreenSharing ? undefined : 'mirrored-video'} />
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
        <button
          className={isScreenSharing ? 'tool-button active-share' : 'tool-button'}
          disabled={!isConnected}
          onClick={handleScreenShareToggle}
          title={isScreenSharing ? 'إيقاف مشاركة الشاشة' : 'مشاركة الشاشة'}
          type="button"
        >
          {isScreenSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </button>
        <button
          className={isPictureInPicture ? 'tool-button active-share' : 'tool-button'}
          disabled={!isConnected}
          onClick={handlePictureInPictureToggle}
          title={isPictureInPicture ? 'إغلاق النافذة العائمة' : 'فتح نافذة عائمة'}
          type="button"
        >
          <PictureInPicture2 size={20} />
        </button>
        {installPrompt && (
          <button className="tool-button" onClick={handleInstallApp} title="تثبيت كتطبيق" type="button">
            <Download size={20} />
          </button>
        )}
        <button className="tool-button danger" disabled={!isConnected} onClick={endCall} title="إنهاء المكالمة" type="button">
          <PhoneOff size={20} />
        </button>
      </div>
    </section>
  );
}
