import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Camera, CameraOff, Download, Grid2X2, MessageSquare, Mic, MicOff, MoreHorizontal, PhoneOff, PictureInPicture2, RadioTower, RefreshCw, ScreenShare, ScreenShareOff, Users } from 'lucide-react';
import { VideoConnection, VideoRole, VideoSource } from '../../services/videoConnection';

const ANDROID_APP_DOWNLOAD_URL = '/downloads/mansah.apk';

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void) => void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };

declare global {
  interface Window {
    mansahCallActive?: boolean;
  }
}

export function VideoRoom({ assignedRole: role, assignedRoom: roomId, authorize }: { assignedRole: VideoRole; assignedRoom: string; authorize: () => Promise<unknown> }) {
  const [status, setStatus] = useState('جاهز لبدء الجلسة');
  const [isConnected, setIsConnected] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showAndroidAppPrompt, setShowAndroidAppPrompt] = useState(false);
  const [remoteVideoSource, setRemoteVideoSource] = useState<VideoSource>('camera');
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [focusedParticipant, setFocusedParticipant] = useState<'local' | 'remote' | null>(null);
  const [sidePanel, setSidePanel] = useState<'participants' | 'chat' | null>(null);
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');
  const [videoRatios, setVideoRatios] = useState({ local: 16 / 9, remote: 16 / 9 });
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<VideoConnection | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const autoJoinStartedRef = useRef(false);
  const localName = role === 'teacher' ? 'الأستاذ' : 'الطالب';
  const remoteName = role === 'teacher' ? 'الطالب' : 'الأستاذ';

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

  useEffect(() => {
    const handleResize = () => {
      updateVideoRatio('local', localVideoRef.current);
      updateVideoRatio('remote', remoteVideoRef.current);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  const startCall = async () => {
    if (isJoining) return;
    setIsJoining(true);
    setStatus('جار الانضمام للغرفة');
    try {
      await authorize();
      connectionRef.current?.close();
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      setIsScreenSharing(false);
      setShowAndroidAppPrompt(false);
      setRemoteVideoSource('camera');
      setHasRemoteStream(false);
      setFocusedParticipant(null);
      const connection = new VideoConnection(roomId.trim(), role, {
        onRemoteStream: (stream) => {
          remoteStreamRef.current = stream;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
          setHasRemoteStream(true);
          setStatus('الاتصال مباشر');
        },
        onRemoteVideoSource: (source) => {
          setRemoteVideoSource(source);
          if (source === 'screen') setFocusedParticipant('remote');
        },
        onLocalVideoSource: (source) => {
          setIsScreenSharing(source === 'screen');
          if (source === 'screen') setFocusedParticipant('local');
        },
        onPeerLeft: () => {
          remoteStreamRef.current = null;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteVideoSource('camera');
          setHasRemoteStream(false);
          setFocusedParticipant(null);
        },
        onStatus: setStatus,
      });
      connectionRef.current = connection;
      const localStream = await connection.start();
      localStreamRef.current = localStream;
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
      setIsConnected(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'تعذر بدء المكالمة');
      setIsConnected(false);
    } finally {
      setIsJoining(false);
    }
  };

  useEffect(() => {
    if (autoJoinStartedRef.current) return;
    autoJoinStartedRef.current = true;
    void startCall();
  }, []);

  const endCall = () => {
    connectionRef.current?.close();
    connectionRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setIsConnected(false);
    setIsJoining(false);
    setIsScreenSharing(false);
    setIsPictureInPicture(false);
    setShowAndroidAppPrompt(false);
    setRemoteVideoSource('camera');
    setHasRemoteStream(false);
    setFocusedParticipant(null);
    setSidePanel(null);
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
        localStreamRef.current = cameraStream ?? localStreamRef.current;
        if (localVideoRef.current && cameraStream) localVideoRef.current.srcObject = cameraStream;
        setIsScreenSharing(false);
        return;
      }
      const screenStream = await connectionRef.current.startScreenShare();
      localStreamRef.current = screenStream;
      if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
      setIsScreenSharing(true);
      setShowAndroidAppPrompt(false);
      setFocusedParticipant('local');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذر مشاركة الشاشة';
      if (message.includes('غير مدعومة')) {
        setShowAndroidAppPrompt(true);
        setStatus('مشاركة شاشة الهاتف تحتاج تطبيق أندرويد');
      } else {
        setStatus(message);
      }
      setIsScreenSharing(false);
    }
  };

  const bindLocalVideo = (element: HTMLVideoElement | null) => {
    localVideoRef.current = element;
    if (element && localStreamRef.current) {
      element.srcObject = localStreamRef.current;
      updateVideoRatio('local', element);
    }
  };

  const bindRemoteVideo = (element: HTMLVideoElement | null) => {
    remoteVideoRef.current = element;
    if (element && remoteStreamRef.current) {
      element.srcObject = remoteStreamRef.current;
      updateVideoRatio('remote', element);
    }
  };

  const updateVideoRatio = (id: 'local' | 'remote', video: HTMLVideoElement | null) => {
    if (!video?.videoWidth || !video.videoHeight) return;
    const ratio = video.videoWidth / video.videoHeight;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setVideoRatios((current) => Math.abs(current[id] - ratio) < 0.01 ? current : { ...current, [id]: ratio });
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
      setStatus(error instanceof Error ? error.message : 'تعذر فتح النافذة العائمة');
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

  const renderTile = (id: 'local' | 'remote', variant: 'grid' | 'focus' | 'pip' = 'grid') => {
    const isLocal = id === 'local';
    const name = isLocal ? localName : remoteName;
    const source: VideoSource = isLocal ? (isScreenSharing ? 'screen' : 'camera') : remoteVideoSource;
    const hasStream = isLocal ? isConnected : hasRemoteStream;
    const showVideo = hasStream && (isLocal ? videoEnabled || isScreenSharing : true);
    const ratio = videoRatios[id];
    return (
      <button
        className={`participant-tile ${variant} ${fitMode === 'fill' ? 'fill-frame' : 'fit-video'} ${source === 'screen' ? 'screen' : ''} ${ratio < 1 ? 'portrait-video' : 'landscape-video'} ${focusedParticipant === id ? 'selected' : ''}`}
        type="button"
        onClick={() => setFocusedParticipant(id)}
        aria-label={`تكبير ${name}`}
        style={{ '--video-ratio': String(ratio) } as CSSProperties}
      >
        <video
          ref={isLocal ? bindLocalVideo : bindRemoteVideo}
          autoPlay
          muted={isLocal}
          playsInline
          onLoadedMetadata={(event) => updateVideoRatio(id, event.currentTarget)}
          onResize={(event) => updateVideoRatio(id, event.currentTarget)}
          className={source === 'camera' ? 'mirrored-video' : undefined}
        />
        {!showVideo && (
          <div className="camera-placeholder" aria-hidden="true">
            <span>{name.slice(0, 1)}</span>
            <strong>{hasStream ? name : 'بانتظار الدخول'}</strong>
            <small>{hasStream ? 'الكاميرا مغلقة' : `${remoteName} لم يدخل بعد`}</small>
          </div>
        )}
        <div className="participant-meta">
          <span>{name}{isLocal ? ' - أنت' : ''}</span>
          {isLocal && !audioEnabled && <MicOff size={15} aria-label="المايك مغلق" />}
          {!showVideo && <CameraOff size={15} aria-label="الكاميرا مغلقة" />}
          {source === 'screen' && <ScreenShare size={15} aria-label="مشاركة شاشة" />}
        </div>
      </button>
    );
  };

  return (
    <section className={`video-room call-experience ${focusedParticipant ? 'focus-mode' : 'grid-mode'} ${sidePanel ? 'panel-open' : ''}`}>
      <div className="video-header call-header">
        <div>
          <h2>الحصة المباشرة</h2>
          <p>{localName} مع {remoteName}</p>
        </div>
        <div className="status-pill"><RadioTower size={17} />{status}</div>
      </div>

      <div className="session-controls call-start">
        {isJoining && <span className="call-joining"><RefreshCw size={16} />جار الانضمام</span>}
        {!isConnected && !isJoining && <button className="primary-button" type="button" onClick={startCall}><RefreshCw size={18} />إعادة المحاولة</button>}
      </div>

      {showAndroidAppPrompt && (
        <div className="unsupported-share-panel" role="status">
          <div><strong>مشاركة الشاشة غير مدعومة من متصفح الهاتف</strong><p>استخدم متصفح الكمبيوتر لمشاركة الشاشة. مشاركة شاشة أندرويد غير متاحة في نسخة التطبيق الحالية.</p></div>
          <a className="download-app-button" href={ANDROID_APP_DOWNLOAD_URL}><Download size={18} />تنزيل التطبيق</a>
        </div>
      )}

      <div className="call-stage">
        <div className="video-grid" aria-label="المشاركون">
          {focusedParticipant ? (
            <>
              {renderTile(focusedParticipant, 'focus')}
              <div className="floating-preview" style={{ '--video-ratio': String(videoRatios[focusedParticipant === 'local' ? 'remote' : 'local']) } as CSSProperties}>{renderTile(focusedParticipant === 'local' ? 'remote' : 'local', 'pip')}</div>
            </>
          ) : (
            <>
              {renderTile('remote')}
              {renderTile('local')}
            </>
          )}
        </div>
        {sidePanel && (
          <aside className="call-side-panel" aria-label={sidePanel === 'chat' ? 'المحادثة' : 'المشاركون'}>
            <div className="panel-title"><strong>{sidePanel === 'chat' ? 'المحادثة' : 'المشاركون'}</strong><button type="button" onClick={() => setSidePanel(null)} aria-label="إغلاق">×</button></div>
            {sidePanel === 'participants' ? <div className="participant-list"><span>{localName} - أنت</span><span>{hasRemoteStream ? remoteName : `${remoteName} بانتظار الدخول`}</span></div> : <p className="panel-empty">رسائل الحصة تبقى في تفاصيل الحصة، وهذه اللوحة جاهزة للمحادثة أثناء الاتصال.</p>}
          </aside>
        )}
      </div>

      <div className="call-toolbar" aria-label="أدوات المكالمة">
        <button className={audioEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleAudioToggle} title={audioEnabled ? 'إيقاف المايك' : 'تشغيل المايك'} type="button">{audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}</button>
        <button className={videoEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleVideoToggle} title={videoEnabled ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا'} type="button">{videoEnabled ? <Camera size={20} /> : <CameraOff size={20} />}</button>
        <button className={isScreenSharing ? 'tool-button active-share' : 'tool-button'} disabled={!isConnected} onClick={handleScreenShareToggle} title={isScreenSharing ? 'إيقاف مشاركة الشاشة' : 'مشاركة الشاشة'} type="button">{isScreenSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}</button>
        <button className="tool-button" disabled={!isConnected} onClick={() => setFocusedParticipant(null)} title="عرض الشبكة" type="button"><Grid2X2 size={20} /></button>
        <button className={sidePanel === 'participants' ? 'tool-button active-share' : 'tool-button'} onClick={() => setSidePanel(sidePanel === 'participants' ? null : 'participants')} title="المشاركون" type="button"><Users size={20} /></button>
        <button className={sidePanel === 'chat' ? 'tool-button active-share' : 'tool-button'} onClick={() => setSidePanel(sidePanel === 'chat' ? null : 'chat')} title="المحادثة" type="button"><MessageSquare size={20} /></button>
        <button className={isPictureInPicture ? 'tool-button active-share' : 'tool-button'} disabled={!isConnected} onClick={handlePictureInPictureToggle} title={isPictureInPicture ? 'إغلاق النافذة العائمة' : 'فتح نافذة عائمة'} type="button"><PictureInPicture2 size={20} /></button>
        {installPrompt && <button className="tool-button" onClick={handleInstallApp} title="تثبيت كتطبيق" type="button"><Download size={20} /></button>}
        <button className={fitMode === 'fill' ? 'tool-button active-share' : 'tool-button'} onClick={() => setFitMode(fitMode === 'fit' ? 'fill' : 'fit')} title={fitMode === 'fit' ? 'Fill frame' : 'Fit video'} type="button"><MoreHorizontal size={20} /></button>
        <button className="tool-button danger" disabled={!isConnected} onClick={endCall} title="إنهاء المكالمة" type="button"><PhoneOff size={20} /></button>
      </div>
    </section>
  );
}
