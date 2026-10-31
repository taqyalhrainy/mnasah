import { t, locale, usePreferences, PreferenceControls } from '../../i18n/preferences';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent, PointerEvent, WheelEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { BringToFront, Camera, CameraOff, ChevronLeft, ChevronRight, Clock3, Copy, Download, FileUp, Grid2X2, Hand, Highlighter, ImagePlus, Maximize2, Menu, MessageSquare, Mic, MicOff, MoreHorizontal, MousePointer2, Pencil, PhoneOff, PictureInPicture2, RefreshCw, ScreenShare, ScreenShareOff, SendToBack, Trash2, Type as TypeIcon, Undo2, Users } from 'lucide-react';
import { VideoConnection, VideoRole, VideoSource } from '../../services/videoConnection';

const MIN_WHITEBOARD_ZOOM = 0.005;
const MAX_WHITEBOARD_ZOOM = 5;
const MIN_STROKE_POINT_DISTANCE = 1.5;
const MAX_STROKE_POINTS = 1200;
const LIVE_STROKE_BROADCAST_INTERVAL_MS = 32;

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void) => void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };
type WhiteboardPoint = { x: number; y: number };
type WhiteboardStroke = { id: string; color: string; size: number; points: WhiteboardPoint[] };
type WhiteboardBaseItem = { id: string; x: number; y: number; width: number; height: number; opacity?: number };
type WhiteboardTextItem = WhiteboardBaseItem & { type: 'text'; text: string; color: string; fontSize: number; fontFamily?: string; fontWeight?: number; fontStyle?: 'normal' | 'italic'; textAlign?: 'start' | 'center' | 'end'; background?: string };
type WhiteboardImageItem = WhiteboardBaseItem & { type: 'image'; src: string; fit?: 'contain' | 'cover'; borderRadius?: number; documentName?: string; documentPage?: number; documentPages?: number };
type WhiteboardItem = WhiteboardTextItem | WhiteboardImageItem;
type SharedDocument = { name: string; page: number; pages: number; src: string; format: 'pdf' | 'presentation' | 'image' | 'text' };
type DocumentPoint = { x: number; y: number };
type DocumentAnnotation = { id: string; page: number; kind: 'pen' | 'highlight'; color: string; size: number; points: DocumentPoint[] } | { id: string; page: number; kind: 'text'; color: string; x: number; y: number; text: string };
type WhiteboardMessage =
  | { kind: 'stroke-start'; stroke: WhiteboardStroke }
  | { kind: 'stroke-points'; id: string; points: WhiteboardPoint[] }
  | { kind: 'stroke'; stroke: WhiteboardStroke }
  | { kind: 'clear' }
  | { kind: 'erase'; ids: string[] }
  | { kind: 'item-upsert'; item: WhiteboardItem }
  | { kind: 'item-delete'; id: string }
  | { kind: 'mode'; mode: StageMode }
  | { kind: 'document'; document: SharedDocument | null }
  | { kind: 'document-annotations'; annotations: DocumentAnnotation[] }
  | { kind: 'sync'; strokes: WhiteboardStroke[]; items?: WhiteboardItem[]; mode?: StageMode; document?: SharedDocument | null; annotations?: DocumentAnnotation[] };
type StageMode = 'video' | 'whiteboard' | 'document';
type WhiteboardTool = 'select' | 'draw' | 'pan' | 'text';
type WhiteboardItemInteraction = { id: string; mode: 'move' | 'resize'; start: WhiteboardPoint; item: WhiteboardItem; moved: boolean };
type WhiteboardDocument = { name: string; page: number; pages: number; itemId: string; pdf: PDFDocumentProxy };
type WhiteboardPinch = { distance: number; center: WhiteboardPoint };
type CallMessage = { id: string; body: string; created: number; name: string; author_id?: string };
type VideoRoomProps = {
  assignedRole: VideoRole;
  assignedRoom: string;
  authorize: () => Promise<unknown>;
  messages?: CallMessage[];
  onSendMessage?: (body: string) => Promise<void>;
  onPresenceChange?: (active: boolean, peerId?: string | null) => Promise<unknown>;
  getRemotePeerId?: () => Promise<string | null | undefined>;
  onLeave?: () => void;
  navigationItems?: Array<{ id: string; label: string }>;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  onExpand?: () => void;
  currentUserId?: string;
  scheduledEnd?: number;
  onGraceExpired?: () => Promise<void> | void;
};

const WhiteboardStrokePath = memo(function WhiteboardStrokePath({ stroke }: { stroke: WhiteboardStroke }) {
  const path = stroke.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return <path d={path} fill="none" stroke={stroke.color} strokeWidth={stroke.size * 2} strokeLinecap="round" strokeLinejoin="round" />;
});

declare global { interface Window { mansahCallActive?: boolean } }

export function VideoRoom({ assignedRole: role, assignedRoom: roomId, authorize, messages = [], onSendMessage, onPresenceChange, getRemotePeerId, onLeave, navigationItems = [], onNavigate, compact = false, onExpand, currentUserId, scheduledEnd, onGraceExpired }: VideoRoomProps) {
  usePreferences();
  const [status, setStatus] = useState(t("جاهز للانضمام"));
  const [isConnected, setIsConnected] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showScreenShareNotice, setShowScreenShareNotice] = useState(false);
  const [remoteVideoSource, setRemoteVideoSource] = useState<VideoSource>('camera');
  const [remoteVideoEnabled, setRemoteVideoEnabled] = useState(false);
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [focusedParticipant, setFocusedParticipant] = useState<'local' | 'remote' | null>(null);
  const [stageMode, setStageMode] = useState<StageMode>('video');
  const [sidePanel, setSidePanel] = useState<'participants' | 'chat' | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [mutedSpeechWarning, setMutedSpeechWarning] = useState(false);
  const [unreadCallMessages, setUnreadCallMessages] = useState(0);
  const [remainingGrace, setRemainingGrace] = useState<number | null>(null);
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');
  const [videoRatios, setVideoRatios] = useState({ local: 16 / 9, remote: 16 / 9 });
  const [whiteboardStrokes, setWhiteboardStrokes] = useState<WhiteboardStroke[]>([]);
  const [whiteboardItems, setWhiteboardItems] = useState<WhiteboardItem[]>([]);
  const [activeStroke, setActiveStroke] = useState<WhiteboardStroke | null>(null);
  const [whiteboardColor, setWhiteboardColor] = useState('#673c7b');
  const [whiteboardSize, setWhiteboardSize] = useState(4);
  const [whiteboardViewport, setWhiteboardViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [whiteboardAspect, setWhiteboardAspect] = useState(1.55);
  const [whiteboardTool, setWhiteboardTool] = useState<WhiteboardTool>('draw');
  const [selectedWhiteboardItem, setSelectedWhiteboardItem] = useState<string | null>(null);
  const [editingWhiteboardText, setEditingWhiteboardText] = useState<string | null>(null);
  const [whiteboardDocument, setWhiteboardDocument] = useState<WhiteboardDocument | null>(null);
  const [whiteboardDocumentBusy, setWhiteboardDocumentBusy] = useState(false);
  const [sharedDocument, setSharedDocument] = useState<SharedDocument | null>(null);
  const [documentTool, setDocumentTool] = useState<'pen' | 'highlight' | 'text'>('pen');
  const [documentColor, setDocumentColor] = useState('#facc15');
  const [documentAnnotations, setDocumentAnnotations] = useState<DocumentAnnotation[]>([]);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const whiteboardSvgRef = useRef<SVGSVGElement>(null);
  const whiteboardImageInputRef = useRef<HTMLInputElement>(null);
  const whiteboardFileInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<VideoConnection | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const autoJoinStartedRef = useRef(false);
  const whiteboardStrokesRef = useRef<WhiteboardStroke[]>([]);
  const whiteboardItemsRef = useRef<WhiteboardItem[]>([]);
  const activeStrokeRef = useRef<WhiteboardStroke | null>(null);
  const activeStrokeFrameRef = useRef<number | null>(null);
  const liveStrokePointsRef = useRef<WhiteboardPoint[]>([]);
  const liveStrokeTimerRef = useRef<number | null>(null);
  const lastLiveStrokeBroadcastRef = useRef(0);
  const panStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const whiteboardItemInteractionRef = useRef<WhiteboardItemInteraction | null>(null);
  const whiteboardPointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const whiteboardPinchRef = useRef<WhiteboardPinch | null>(null);
  const whiteboardDocumentRef = useRef<WhiteboardDocument | null>(null);
  const sharedDocumentSourceRef = useRef<{ name: string; pages: number; format: SharedDocument['format']; render: (page: number) => Promise<string>; destroy?: () => void | Promise<void> } | null>(null);
  const sharedDocumentRef = useRef<SharedDocument | null>(null);
  const stageModeRef = useRef<StageMode>('video');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const presenceRef = useRef(onPresenceChange);
  const localPeerIdRef = useRef<string | null>(null);
  const localTypingTimerRef = useRef<number | null>(null);
  const remoteTypingTimerRef = useRef<number | null>(null);
  const audioMonitorRef = useRef<{ context: AudioContext; track: MediaStreamTrack; frame: number } | null>(null);
  const speakingRef = useRef(false);
  const mutedWarningTimerRef = useRef<number | null>(null);
  const messageCountRef = useRef(messages.length);
  const documentAnnotationsRef = useRef<DocumentAnnotation[]>([]);
  const documentDrawingRef = useRef<DocumentAnnotation | null>(null);
  const documentBroadcastFrameRef = useRef<number | null>(null);
  const graceExpiredRef = useRef(false);
  const localName = role === 'teacher' ? t("الأستاذ") : t("الطالب");
  const remoteName = role === 'teacher' ? t("الطالب") : t("الأستاذ");

  useEffect(() => { presenceRef.current = onPresenceChange; }, [onPresenceChange]);
  useEffect(() => { sharedDocumentRef.current = sharedDocument; }, [sharedDocument]);
  useEffect(() => { stageModeRef.current = stageMode; }, [stageMode]);
  useEffect(() => { documentAnnotationsRef.current = documentAnnotations; }, [documentAnnotations]);

  useEffect(() => {
    const previous = messageCountRef.current;
    if (messages.length > previous && sidePanel !== 'chat') {
      const incoming = messages.slice(previous).filter(message => !currentUserId || message.author_id !== currentUserId).length;
      if (incoming) setUnreadCallMessages(value => value + incoming);
    }
    messageCountRef.current = messages.length;
  }, [messages, sidePanel, currentUserId]);

  useEffect(() => {
    if (sidePanel === 'chat') setUnreadCallMessages(0);
  }, [sidePanel]);

  useEffect(() => {
    if (!scheduledEnd || !isConnected) { setRemainingGrace(null); graceExpiredRef.current = false; return; }
    const update = () => {
      const now = Date.now();
      if (now < scheduledEnd) { setRemainingGrace(null); return; }
      const left = Math.max(0, scheduledEnd + 5 * 60000 - now);
      setRemainingGrace(left);
      if (!left && !graceExpiredRef.current) {
        graceExpiredRef.current = true;
        Promise.resolve(onGraceExpired?.()).catch(() => undefined).finally(() => endCall());
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [scheduledEnd, isConnected]);

  useEffect(() => () => {
    window.mansahCallActive = false;
    if (activeStrokeFrameRef.current !== null) cancelAnimationFrame(activeStrokeFrameRef.current);
    if (liveStrokeTimerRef.current !== null) window.clearTimeout(liveStrokeTimerRef.current);
    if (localTypingTimerRef.current !== null) window.clearTimeout(localTypingTimerRef.current);
    if (remoteTypingTimerRef.current !== null) window.clearTimeout(remoteTypingTimerRef.current);
    if (documentBroadcastFrameRef.current !== null) cancelAnimationFrame(documentBroadcastFrameRef.current);
    if (mutedWarningTimerRef.current !== null) window.clearTimeout(mutedWarningTimerRef.current);
    if (audioMonitorRef.current) {
      cancelAnimationFrame(audioMonitorRef.current.frame);
      audioMonitorRef.current.track.stop();
      void audioMonitorRef.current.context.close();
      audioMonitorRef.current = null;
    }
    connectionRef.current?.sendTyping(false);
    void wakeLockRef.current?.release();
    void whiteboardDocumentRef.current?.pdf.destroy();
    void sharedDocumentSourceRef.current?.destroy?.();
    connectionRef.current?.close();
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
    if (!isConnected || !presenceRef.current) return;
    void presenceRef.current(true, localPeerIdRef.current).catch(() => undefined);
    const timer = window.setInterval(() => { const update = presenceRef.current?.(true, localPeerIdRef.current); if (update) void update.catch(() => undefined); }, 15000);
    const refreshPresence = () => { if (document.visibilityState === 'visible') { const update = presenceRef.current?.(true, localPeerIdRef.current); if (update) void update.catch(() => undefined); } };
    document.addEventListener('visibilitychange', refreshPresence);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshPresence); const update = presenceRef.current?.(false); if (update) void update.catch(() => undefined); };
  }, [isConnected]);

  useEffect(() => {
    if (sidePanel === 'chat') chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sidePanel, remoteTyping]);

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
        wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
      } catch { wakeLockRef.current = null; }
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
      const rect = whiteboardSvgRef.current?.getBoundingClientRect();
      if (rect?.width && rect.height) setWhiteboardAspect(rect.width / rect.height);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  useEffect(() => {
    const blockBrowserZoom = (event: globalThis.WheelEvent) => {
      const target = event.target as Element | null;
      if (stageMode === 'whiteboard' && target?.closest('.whiteboard-panel') && (event.ctrlKey || event.metaKey)) event.preventDefault();
    };
    const blockBrowserZoomKeys = (event: KeyboardEvent) => {
      if (stageMode !== 'whiteboard' || (!event.ctrlKey && !event.metaKey)) return;
      if (['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
    };
    document.addEventListener('wheel', blockBrowserZoom, { passive: false, capture: true });
    document.addEventListener('keydown', blockBrowserZoomKeys, { capture: true });
    return () => {
      document.removeEventListener('wheel', blockBrowserZoom, { capture: true });
      document.removeEventListener('keydown', blockBrowserZoomKeys, { capture: true });
    };
  }, [stageMode]);

  useEffect(() => {
    if (autoJoinStartedRef.current) return;
    autoJoinStartedRef.current = true;
    void startCall();
  }, []);

  const startCall = async () => {
    if (isJoining) return;
    setIsJoining(true);
    setStatus(t("جار الانضمام للغرفة"));
    try {
      await authorize();
      connectionRef.current?.close();
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      setIsScreenSharing(false);
      setShowScreenShareNotice(false);
      setRemoteVideoSource('camera');
      setRemoteVideoEnabled(false);
      setHasRemoteStream(false);
      setFocusedParticipant(null);
      localPeerIdRef.current = null;
      const connection = new VideoConnection(roomId.trim(), role, {
        onRemoteStream: (stream) => {
          remoteStreamRef.current = stream;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = stream;
            void remoteVideoRef.current.play().catch(() => undefined);
          }
          setHasRemoteStream(true);
          setStatus(t("متصل"));
        },
        onRemoteVideoSource: (source) => {
          setRemoteVideoSource(source);
          if (source === 'screen') {
            setStageMode('video');
            setFocusedParticipant('remote');
          }
        },
        onRemoteVideoEnabled: setRemoteVideoEnabled,
        onWhiteboardMessage: handleWhiteboardMessage,
        onRemoteTyping: (typing) => {
          if (remoteTypingTimerRef.current !== null) window.clearTimeout(remoteTypingTimerRef.current);
          setRemoteTyping(typing);
          if (typing) remoteTypingTimerRef.current = window.setTimeout(() => setRemoteTyping(false), 1800);
        },
        onRemoteSpeaking: setRemoteSpeaking,
        onDataOpen: () => sendWhiteboard({ kind: 'sync', strokes: whiteboardStrokesRef.current, items: whiteboardItemsRef.current, mode: stageModeRef.current, document: sharedDocumentRef.current, annotations: documentAnnotationsRef.current }),
        onLocalPeerId: (peerId) => {
          localPeerIdRef.current = peerId;
          const update = presenceRef.current?.(Boolean(peerId), peerId);
          if (update) void update.catch(() => undefined);
        },
        getRemotePeerId,
        onLocalVideoSource: (source) => {
          setIsScreenSharing(source === 'screen');
          if (source === 'screen') {
            setStageMode('video');
            setFocusedParticipant('local');
          }
        },
        onPeerLeft: () => {
          if (remoteTypingTimerRef.current !== null) window.clearTimeout(remoteTypingTimerRef.current);
          setRemoteTyping(false);
          remoteStreamRef.current = null;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          setRemoteVideoSource('camera');
          setRemoteVideoEnabled(false);
          setHasRemoteStream(false);
          setFocusedParticipant(null);
        },
        onStatus: setStatus,
      });
      connectionRef.current = connection;
      const localStream = await connection.start();
      localStreamRef.current = localStream;
      startAudioMonitor(localStream);
      setVideoEnabled(false);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
        void localVideoRef.current.play().catch(() => undefined);
      }
      setIsConnected(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("تعذر بدء المكالمة"));
      setIsConnected(false);
    } finally {
      setIsJoining(false);
    }
  };

  const startAudioMonitor = (stream: MediaStream) => {
    const sourceTrack = stream.getAudioTracks()[0];
    if (!sourceTrack || audioMonitorRef.current) return;
    try {
      const monitorTrack = sourceTrack.clone();
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = .62;
      context.createMediaStreamSource(new MediaStream([monitorTrack])).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let quietFrames = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) { const normalized = (sample - 128) / 128; sum += normalized * normalized; }
        const speaking = Math.sqrt(sum / samples.length) > .045;
        quietFrames = speaking ? 0 : quietFrames + 1;
        const stableSpeaking = speaking || (speakingRef.current && quietFrames < 5);
        if (stableSpeaking !== speakingRef.current) {
          speakingRef.current = stableSpeaking;
          setLocalSpeaking(stableSpeaking);
          connectionRef.current?.sendSpeaking(stableSpeaking);
        }
        if (speaking && !sourceTrack.enabled) {
          setMutedSpeechWarning(true);
          if (mutedWarningTimerRef.current !== null) window.clearTimeout(mutedWarningTimerRef.current);
          mutedWarningTimerRef.current = window.setTimeout(() => setMutedSpeechWarning(false), 1800);
        }
        if (audioMonitorRef.current) audioMonitorRef.current.frame = requestAnimationFrame(tick);
      };
      audioMonitorRef.current = { context, track: monitorTrack, frame: requestAnimationFrame(tick) };
      void context.resume().catch(() => undefined);
    } catch { /* Voice activity is an enhancement; the call continues without it. */ }
  };

  const endCall = () => {
    connectionRef.current?.sendTyping(false);
    connectionRef.current?.close();
    connectionRef.current = null;
    localPeerIdRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setIsConnected(false);
    setIsJoining(false);
    setIsScreenSharing(false);
    setIsPictureInPicture(false);
    setShowScreenShareNotice(false);
    setRemoteVideoSource('camera');
    setRemoteVideoEnabled(false);
    setHasRemoteStream(false);
    setFocusedParticipant(null);
    setStageMode('video');
    setSidePanel(null);
    setShowMore(false);
    setRemoteTyping(false);
    setStatus(t("تم إنهاء الجلسة"));
    window.mansahCallActive = false;
    const presenceUpdate = onPresenceChange?.(false);
    if (presenceUpdate) void presenceUpdate.catch(() => undefined);
    onLeave?.();
  };

  const updateLocalTyping = (typing: boolean) => {
    if (localTypingTimerRef.current !== null) window.clearTimeout(localTypingTimerRef.current);
    connectionRef.current?.sendTyping(typing);
    if (typing) {
      localTypingTimerRef.current = window.setTimeout(() => {
        connectionRef.current?.sendTyping(false);
        localTypingTimerRef.current = null;
      }, 1200);
    } else {
      localTypingTimerRef.current = null;
    }
  };

  const sendChatMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body || !onSendMessage || chatSending) return;
    updateLocalTyping(false);
    setChatSending(true);
    try { await onSendMessage(body); setChatDraft(''); }
    finally { setChatSending(false); }
  };

  const handleAudioToggle = () => {
    const nextValue = !audioEnabled;
    setAudioEnabled(nextValue);
    connectionRef.current?.toggleAudio(nextValue);
    if (nextValue) setMutedSpeechWarning(false);
    void audioMonitorRef.current?.context.resume().catch(() => undefined);
  };

  const handleVideoToggle = async () => {
    const connection = connectionRef.current;
    if (!connection) return;
    const nextValue = !videoEnabled;
    try {
      const stream = await connection.toggleVideo(nextValue);
      localStreamRef.current = stream ?? localStreamRef.current;
      if (localVideoRef.current && stream) {
        localVideoRef.current.srcObject = stream;
        void localVideoRef.current.play().catch(() => undefined);
      }
      setVideoEnabled(nextValue);
    } catch (error) {
      setVideoEnabled(false);
      setStatus(error instanceof Error ? error.message : t('تعذر تشغيل الكاميرا على هذا الجهاز.'));
    }
  };

  const enterPictureInPicture = async (reportError = true) => {
    try {
      const targetVideo = remoteVideoRef.current?.srcObject ? remoteVideoRef.current : localVideoRef.current;
      if (!targetVideo?.srcObject || !document.pictureInPictureEnabled || !targetVideo.requestPictureInPicture) {
        if (reportError) setStatus(t('النافذة العائمة غير مدعومة على هذا المتصفح.'));
        return false;
      }
      await targetVideo.play();
      await targetVideo.requestPictureInPicture();
      setIsPictureInPicture(true);
      return true;
    } catch (error) {
      if (reportError) setStatus(error instanceof Error ? error.message : t("تعذر فتح النافذة العائمة"));
      setIsPictureInPicture(false);
      return false;
    }
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
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
        void localVideoRef.current.play().catch(() => undefined);
      }
      setIsScreenSharing(true);
      setShowScreenShareNotice(false);
      setStageMode('video');
      setFocusedParticipant('local');
      if (window.matchMedia('(max-width: 900px)').matches) {
        const opened = await enterPictureInPicture(false);
        if (!opened) setShowScreenShareNotice(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("تعذر مشاركة الشاشة");
      setStatus(message);
      if (/غير مدعومة|not supported/i.test(message)) setShowScreenShareNotice(true);
      setIsScreenSharing(false);
    }
  };

  const updateVideoRatio = useCallback((id: 'local' | 'remote', video: HTMLVideoElement | null) => {
    if (!video?.videoWidth || !video.videoHeight) return;
    const ratio = video.videoWidth / video.videoHeight;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setVideoRatios((current) => Math.abs(current[id] - ratio) < 0.01 ? current : { ...current, [id]: ratio });
  }, []);

  const bindLocalVideo = useCallback((element: HTMLVideoElement | null) => {
    localVideoRef.current = element;
    if (element && localStreamRef.current) {
      if (element.srcObject !== localStreamRef.current) element.srcObject = localStreamRef.current;
      void element.play().catch(() => undefined);
      updateVideoRatio('local', element);
    }
  }, [updateVideoRatio]);

  const bindRemoteVideo = useCallback((element: HTMLVideoElement | null) => {
    remoteVideoRef.current = element;
    if (element && remoteStreamRef.current) {
      if (element.srcObject !== remoteStreamRef.current) element.srcObject = remoteStreamRef.current;
      void element.play().catch(() => undefined);
      updateVideoRatio('remote', element);
    }
  }, [updateVideoRatio]);

  const handlePictureInPictureToggle = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPictureInPicture(false);
        return;
      }
      await enterPictureInPicture();
    } catch { setIsPictureInPicture(false); }
  };

  useEffect(() => {
    const handleLeavePictureInPicture = () => setIsPictureInPicture(false);
    const handleVisibilityForFloatingCall = () => {
      if (document.visibilityState === 'hidden' && isConnected && isScreenSharing && !document.pictureInPictureElement) {
        void enterPictureInPicture(false);
      }
    };
    document.addEventListener('leavepictureinpicture', handleLeavePictureInPicture);
    document.addEventListener('visibilitychange', handleVisibilityForFloatingCall);
    return () => {
      document.removeEventListener('leavepictureinpicture', handleLeavePictureInPicture);
      document.removeEventListener('visibilitychange', handleVisibilityForFloatingCall);
    };
  }, [isConnected, isScreenSharing]);

  const handleInstallApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstallPrompt(null);
  };

  const isWhiteboardMessage = (message: unknown): message is WhiteboardMessage => {
    if (!message || typeof message !== 'object') return false;
    const kind = (message as { kind?: unknown }).kind;
    return kind === 'clear' || kind === 'stroke-start' || kind === 'stroke-points' || kind === 'stroke' || kind === 'sync' || kind === 'mode' || kind === 'document' || kind === 'document-annotations' || kind === 'erase' || kind === 'item-upsert' || kind === 'item-delete';
  };

  const setSyncedWhiteboardStrokes = (next: WhiteboardStroke[] | ((current: WhiteboardStroke[]) => WhiteboardStroke[])) => {
    setWhiteboardStrokes((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      whiteboardStrokesRef.current = value;
      return value;
    });
  };

  const setSyncedWhiteboardItems = (next: WhiteboardItem[] | ((current: WhiteboardItem[]) => WhiteboardItem[])) => {
    setWhiteboardItems((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      whiteboardItemsRef.current = value;
      return value;
    });
  };

  const upsertWhiteboardItem = (item: WhiteboardItem, broadcast = false) => {
    setSyncedWhiteboardItems((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.id === item.id);
      if (existingIndex < 0) return [...current, item];
      return current.map((candidate, index) => index === existingIndex ? item : candidate);
    });
    if (broadcast) sendWhiteboard({ kind: 'item-upsert', item });
  };

  const deleteWhiteboardItem = (id: string, broadcast = true) => {
    setSyncedWhiteboardItems((current) => current.filter((item) => item.id !== id));
    setSelectedWhiteboardItem((current) => current === id ? null : current);
    setEditingWhiteboardText((current) => current === id ? null : current);
    if (broadcast) sendWhiteboard({ kind: 'item-delete', id });
  };

  const handleWhiteboardMessage = (message: unknown) => {
    if (!isWhiteboardMessage(message)) return;
    if (message.kind === 'clear') {
      setSyncedWhiteboardStrokes([]);
      setSyncedWhiteboardItems([]);
      setSelectedWhiteboardItem(null);
      setEditingWhiteboardText(null);
      return;
    }
    if (message.kind === 'erase') return setSyncedWhiteboardStrokes((current) => current.filter((stroke) => !message.ids.includes(stroke.id)));
    if (message.kind === 'item-delete') return deleteWhiteboardItem(message.id, false);
    if (message.kind === 'item-upsert') {
      upsertWhiteboardItem(message.item);
      ensureWhiteboardContentVisible(whiteboardStrokesRef.current, [...whiteboardItemsRef.current.filter((item) => item.id !== message.item.id), message.item]);
      return;
    }
    if (message.kind === 'mode') return setStageMode(message.mode);
    if (message.kind === 'document') {
      setSharedDocument(message.document);
      if (message.document) setStageMode('document');
      else setStageMode('video');
      return;
    }
    if (message.kind === 'document-annotations') {
      setDocumentAnnotations(message.annotations);
      documentAnnotationsRef.current = message.annotations;
      return;
    }
    if (message.kind === 'sync') {
      if (message.mode) setStageMode(message.mode);
      if (message.document !== undefined) setSharedDocument(message.document);
      if (message.annotations) {
        setDocumentAnnotations(message.annotations);
        documentAnnotationsRef.current = message.annotations;
      }
      const items = message.items || [];
      ensureWhiteboardContentVisible(message.strokes, items);
      setSyncedWhiteboardStrokes(message.strokes);
      setSyncedWhiteboardItems(items);
      return;
    }
    if (message.kind === 'stroke-start') {
      return setSyncedWhiteboardStrokes((current) => {
        const existingIndex = current.findIndex((stroke) => stroke.id === message.stroke.id);
        if (existingIndex < 0) return [...current, message.stroke];
        const next = [...current];
        next[existingIndex] = message.stroke;
        return next;
      });
    }
    if (message.kind === 'stroke-points') {
      if (!message.points.length) return;
      return setSyncedWhiteboardStrokes((current) => {
        const existingIndex = current.findIndex((stroke) => stroke.id === message.id);
        if (existingIndex < 0) return current;
        const next = [...current];
        const stroke = current[existingIndex];
        next[existingIndex] = { ...stroke, points: [...stroke.points, ...message.points] };
        return next;
      });
    }
    setSyncedWhiteboardStrokes((current) => {
      const existingIndex = current.findIndex((stroke) => stroke.id === message.stroke.id);
      const next = existingIndex < 0 ? [...current, message.stroke] : current.map((stroke, index) => index === existingIndex ? message.stroke : stroke);
      ensureWhiteboardContentVisible(next);
      return next;
    });
  };

  const sendWhiteboard = (message: WhiteboardMessage) => {
    connectionRef.current?.sendWhiteboard(message);
  };

  const createWhiteboardId = (kind: string) => `${Date.now()}-${role}-${kind}-${Math.random().toString(36).slice(2)}`;
  const isOwnedWhiteboardId = (id: string) => role === 'teacher' || id.includes(`-${role}-`);

  const whiteboardPoint = (event: PointerEvent<SVGSVGElement> | WheelEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    updateWhiteboardAspect(svg);
    return whiteboardPointFromClient(svg, event.clientX, event.clientY);
  };

  const whiteboardPointFromClient = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const updateWhiteboardAspect = (svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const next = rect.width / rect.height;
    if (Number.isFinite(next) && Math.abs(next - whiteboardAspect) > 0.02) setWhiteboardAspect(next);
  };

  const getLiveWhiteboardAspect = () => {
    const rect = whiteboardSvgRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return whiteboardAspect;
    const next = rect.width / rect.height;
    if (!Number.isFinite(next) || next <= 0) return whiteboardAspect;
    if (Math.abs(next - whiteboardAspect) > 0.02) setWhiteboardAspect(next);
    return next;
  };

  const scheduleActiveStrokePaint = () => {
    if (activeStrokeFrameRef.current !== null) return;
    activeStrokeFrameRef.current = requestAnimationFrame(() => {
      activeStrokeFrameRef.current = null;
      const stroke = activeStrokeRef.current;
      setActiveStroke(stroke ? { ...stroke, points: [...stroke.points] } : null);
    });
  };

  const flushLiveStrokePoints = () => {
    if (liveStrokeTimerRef.current !== null) {
      window.clearTimeout(liveStrokeTimerRef.current);
      liveStrokeTimerRef.current = null;
    }
    const stroke = activeStrokeRef.current;
    const points = liveStrokePointsRef.current;
    if (!stroke || !points.length) return;
    liveStrokePointsRef.current = [];
    lastLiveStrokeBroadcastRef.current = performance.now();
    sendWhiteboard({ kind: 'stroke-points', id: stroke.id, points });
  };

  const scheduleLiveStrokeBroadcast = () => {
    if (liveStrokeTimerRef.current !== null) return;
    const elapsed = performance.now() - lastLiveStrokeBroadcastRef.current;
    const delay = Math.max(0, LIVE_STROKE_BROADCAST_INTERVAL_MS - elapsed);
    liveStrokeTimerRef.current = window.setTimeout(flushLiveStrokePoints, delay);
  };

  const startWhiteboardItemInteraction = (event: PointerEvent<SVGGElement | SVGCircleElement>, item: WhiteboardItem, mode: 'move' | 'resize') => {
    if (whiteboardTool !== 'select') return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const svg = whiteboardSvgRef.current;
    if (!svg) return;
    const syntheticEvent = { currentTarget: svg, clientX: event.clientX, clientY: event.clientY } as PointerEvent<SVGSVGElement>;
    whiteboardItemInteractionRef.current = { id: item.id, mode, start: whiteboardPoint(syntheticEvent), item: { ...item }, moved: false };
    setSelectedWhiteboardItem(item.id);
    if (mode === 'move') setEditingWhiteboardText(null);
    setWhiteboardTool('select');
  };

  const addWhiteboardText = (point: WhiteboardPoint) => {
    const item: WhiteboardTextItem = {
      id: createWhiteboardId('text'),
      type: 'text',
      x: point.x,
      y: point.y,
      width: 300 / whiteboardViewport.zoom,
      height: 100 / whiteboardViewport.zoom,
      text: '',
      color: '#18171c',
      fontSize: 34 / whiteboardViewport.zoom,
      fontFamily: 'Tajawal, sans-serif',
      fontWeight: 700,
      fontStyle: 'normal',
      textAlign: 'start',
      background: 'transparent',
      opacity: 1,
    };
    upsertWhiteboardItem(item, true);
    setSelectedWhiteboardItem(item.id);
    setEditingWhiteboardText(null);
    setWhiteboardTool('select');
    window.setTimeout(() => setEditingWhiteboardText(item.id), 0);
  };

  const addRasterToWhiteboard = (src: string, pixelWidth: number, pixelHeight: number, documentMeta?: { name: string; page: number; pages: number }) => {
      const currentViewWidth = 1000 / whiteboardViewport.zoom;
      const currentViewHeight = currentViewWidth / getLiveWhiteboardAspect();
      const maxWidth = Math.min(460 / whiteboardViewport.zoom, currentViewWidth * 0.42);
      const maxHeight = Math.min(320 / whiteboardViewport.zoom, currentViewHeight * 0.46);
      const displayScale = Math.min(1, maxWidth / pixelWidth, maxHeight / pixelHeight);
      const width = pixelWidth * displayScale;
      const height = width * (pixelHeight / pixelWidth);
      const item: WhiteboardImageItem = {
        id: createWhiteboardId('image'),
        type: 'image',
        x: whiteboardViewport.x + (currentViewWidth - width) / 2,
        y: whiteboardViewport.y + (currentViewHeight - height) / 2,
        width,
        height,
        src,
        fit: 'contain',
        borderRadius: 0,
        opacity: 1,
        ...(documentMeta ? { documentName: documentMeta.name, documentPage: documentMeta.page, documentPages: documentMeta.pages } : {}),
      };
      upsertWhiteboardItem(item, true);
      setSelectedWhiteboardItem(item.id);
      setEditingWhiteboardText(null);
      setWhiteboardTool('select');
      return item;
  };

  const loadWhiteboardImage = async (file: File) => {
    if (!file.type.startsWith('image/')) throw new Error(t('اختر ملف صورة صالحاً.'));
    if (file.size > 12 * 1024 * 1024) throw new Error(t('الصورة أكبر من 12 ميغابايت.'));
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(t('تعذر قراءة الصورة.')));
        element.src = objectUrl;
      });
      const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('تعذر تجهيز الصورة للوح.'));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      addRasterToWhiteboard(canvas.toDataURL('image/webp', 0.92), canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const renderWhiteboardPdfPage = async (pdf: PDFDocumentProxy, pageNumber: number, name: string, itemId?: string) => {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / baseViewport.width, 1200 / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error(t('تعذر تجهيز صفحة الملف للوح.'));
    await page.render({ canvasContext: context, viewport }).promise;
    const src = canvas.toDataURL('image/webp', 0.9);
    const existing = itemId ? whiteboardItemsRef.current.find((item): item is WhiteboardImageItem => item.id === itemId && item.type === 'image') : undefined;
    if (existing) {
      const item = { ...existing, src, documentName: name, documentPage: pageNumber, documentPages: pdf.numPages };
      upsertWhiteboardItem(item, true);
      setSelectedWhiteboardItem(item.id);
      return item;
    }
    return addRasterToWhiteboard(src, canvas.width, canvas.height, { name, page: pageNumber, pages: pdf.numPages });
  };

  const loadWhiteboardFile = async (file: File) => {
    if (file.type.startsWith('image/')) return loadWhiteboardImage(file);
    const extension = file.name.toLowerCase().split('.').pop() || '';
    if (['txt', 'md', 'csv', 'json', 'html', 'css', 'js', 'ts', 'tsx'].includes(extension) || file.type.startsWith('text/')) {
      if (file.size > 2 * 1024 * 1024) throw new Error(t('الملف النصي أكبر من 2 ميغابايت.'));
      const text = (await file.text()).slice(0, 12000);
      const currentViewWidth = 1000 / whiteboardViewport.zoom;
      const currentViewHeight = currentViewWidth / getLiveWhiteboardAspect();
      const item: WhiteboardTextItem = { id: createWhiteboardId('file-text'), type: 'text', x: whiteboardViewport.x + currentViewWidth * .1, y: whiteboardViewport.y + currentViewHeight * .08, width: currentViewWidth * .8, height: currentViewHeight * .84, text: `${file.name}\n\n${text}`, color: '#18171c', fontSize: 20 / whiteboardViewport.zoom, fontFamily: 'Tajawal, sans-serif', fontWeight: 500, fontStyle: 'normal', textAlign: 'start', background: '#ffffff', opacity: 1 };
      upsertWhiteboardItem(item, true); setSelectedWhiteboardItem(item.id); setWhiteboardTool('select'); return item;
    }
    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(extension)) throw new Error(t('للحفاظ على شكل صفحات Word وPowerPoint أثناء الشرح، احفظ الملف بصيغة PDF ثم ارفعه هنا.'));
    if (file.type !== 'application/pdf' && extension !== 'pdf') throw new Error(t('يمكن فتح PDF والصور والملفات النصية على مساحة الشرح.'));
    if (file.size > 20 * 1024 * 1024) throw new Error(t('الملف أكبر من 20 ميغابايت.'));
    setWhiteboardDocumentBusy(true);
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const previous = whiteboardDocumentRef.current;
      const item = await renderWhiteboardPdfPage(pdf, 1, file.name);
      if (previous) void previous.pdf.destroy();
      const next = { name: file.name, page: 1, pages: pdf.numPages, itemId: item.id, pdf };
      whiteboardDocumentRef.current = next;
      setWhiteboardDocument(next);
    } finally {
      setWhiteboardDocumentBusy(false);
    }
  };

  const changeWhiteboardDocumentPage = async (direction: -1 | 1) => {
    const current = whiteboardDocumentRef.current;
    if (!current || whiteboardDocumentBusy) return;
    const page = Math.min(current.pages, Math.max(1, current.page + direction));
    if (page === current.page) return;
    setWhiteboardDocumentBusy(true);
    try {
      await renderWhiteboardPdfPage(current.pdf, page, current.name, current.itemId);
      const next = { ...current, page };
      whiteboardDocumentRef.current = next;
      setWhiteboardDocument(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('تعذر فتح صفحة الملف.'));
    } finally {
      setWhiteboardDocumentBusy(false);
    }
  };

  const handleWhiteboardImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void loadWhiteboardImage(file).catch((error) => setStatus(error instanceof Error ? error.message : t('تعذر إضافة الصورة إلى اللوح.')));
  };

  const publishSharedDocumentPage = async (page: number) => {
    const source = sharedDocumentSourceRef.current;
    if (!source || whiteboardDocumentBusy) return;
    const selectedPage = Math.min(source.pages, Math.max(1, page));
    setWhiteboardDocumentBusy(true);
    try {
      const document = { name: source.name, page: selectedPage, pages: source.pages, src: await source.render(selectedPage), format: source.format } satisfies SharedDocument;
      setSharedDocument(document);
      setStageMode('document');
      sendWhiteboard({ kind: 'document', document });
    } finally {
      setWhiteboardDocumentBusy(false);
    }
  };

  const loadSharedDocument = async (file: File) => {
    if (!file.size) throw new Error(t('اختر ملفاً غير فارغ.'));
    if (file.size > 50 * 1024 * 1024) throw new Error(t('الملف أكبر من 50 ميغابايت.'));
    const extension = file.name.toLowerCase().split('.').pop() || '';
    await sharedDocumentSourceRef.current?.destroy?.();
    let source: typeof sharedDocumentSourceRef.current;
    if (file.type === 'application/pdf' || extension === 'pdf') {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      source = {
        name: file.name,
        pages: pdf.numPages,
        format: 'pdf',
        render: async (pageNumber) => {
          const page = await pdf.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2.2, 1920 / base.width, 1200 / base.height) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error(t('تعذر تجهيز صفحة الملف.'));
          await page.render({ canvasContext: context, viewport }).promise;
          return canvas.toDataURL('image/webp', .92);
        },
        destroy: () => pdf.destroy(),
      };
    } else if (['ppt', 'pptx'].includes(extension)) {
      const { parse, renderSlideToSvg } = await import('@web-ppt/core');
      const presentation = await parse(file);
      source = {
        name: file.name,
        pages: presentation.slides.length,
        format: 'presentation',
        render: async (pageNumber) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSlideToSvg(presentation, presentation.slides[pageNumber - 1]))}`,
        destroy: () => presentation.dispose?.(),
      };
    } else if (file.type.startsWith('image/')) {
      const src = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      source = { name: file.name, pages: 1, format: 'image', render: async () => src };
    } else if (file.type.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(extension)) {
      const raw = (await file.text()).slice(0, 20000);
      const escaped = raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="white"/><foreignObject x="70" y="60" width="1460" height="780"><pre xmlns="http://www.w3.org/1999/xhtml" style="font:24px Tajawal,Arial;white-space:pre-wrap;direction:auto;color:#17151b">${escaped}</pre></foreignObject></svg>`;
      source = { name: file.name, pages: 1, format: 'text', render: async () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
    } else {
      throw new Error(t('الصيغ المدعومة للعرض: PDF وPowerPoint والصور والملفات النصية.'));
    }
    if (!source?.pages) throw new Error(t('الملف لا يحتوي على صفحات قابلة للعرض.'));
    sharedDocumentSourceRef.current = source;
    await publishSharedDocumentPage(1);
  };

  const changeSharedDocumentPage = (direction: -1 | 1) => {
    if (!sharedDocument) return;
    void publishSharedDocumentPage(sharedDocument.page + direction).catch(error => setStatus(error instanceof Error ? error.message : t('تعذر فتح صفحة الملف.')));
  };

  const closeSharedDocument = () => {
    setSharedDocument(null);
    setStageMode('video');
    sendWhiteboard({ kind: 'document', document: null });
  };

  const handleWhiteboardFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFocusedParticipant(null); setSidePanel(null); setShowMore(false);
    void loadSharedDocument(file).catch((error) => setStatus(error instanceof Error ? error.message : t('تعذر فتح الملف.')));
  };

  useEffect(() => {
    if (stageMode !== 'whiteboard') return;
    const handlePaste = (event: globalThis.ClipboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const imageItem = Array.from(event.clipboardData?.items || []).find(item => item.kind === 'file' && item.type.startsWith('image/'));
      const image = imageItem?.getAsFile();
      if (!image) return;
      event.preventDefault();
      void loadWhiteboardImage(image)
        .then(() => setStatus(t('تم لصق الصورة على اللوح.')))
        .catch((error) => setStatus(error instanceof Error ? error.message : t('تعذر لصق الصورة على اللوح.')));
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [stageMode, whiteboardViewport.x, whiteboardViewport.y, whiteboardViewport.zoom, whiteboardAspect]);

  const selectedWhiteboardObject = whiteboardItems.find((item) => item.id === selectedWhiteboardItem) || null;

  const updateSelectedWhiteboardItem = (changes: Partial<WhiteboardItem>) => {
    if (!selectedWhiteboardObject) return;
    upsertWhiteboardItem({ ...selectedWhiteboardObject, ...changes } as WhiteboardItem, true);
  };

  const duplicateWhiteboardItem = () => {
    if (!selectedWhiteboardObject) return;
    const item = { ...selectedWhiteboardObject, id: createWhiteboardId('copy'), x: selectedWhiteboardObject.x + 28 / whiteboardViewport.zoom, y: selectedWhiteboardObject.y + 28 / whiteboardViewport.zoom } as WhiteboardItem;
    upsertWhiteboardItem(item, true);
    setSelectedWhiteboardItem(item.id);
  };

  const moveWhiteboardLayer = (direction: 'front' | 'back') => {
    if (!selectedWhiteboardItem) return;
    const selected = whiteboardItemsRef.current.find(item => item.id === selectedWhiteboardItem);
    if (!selected) return;
    const rest = whiteboardItemsRef.current.filter(item => item.id !== selectedWhiteboardItem);
    const next = direction === 'front' ? [...rest, selected] : [selected, ...rest];
    setSyncedWhiteboardItems(next);
    sendWhiteboard({ kind: 'sync', strokes: whiteboardStrokesRef.current, items: next, mode: stageMode });
  };

  const downloadWhiteboard = () => {
    const svg = whiteboardSvgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', '1600');
    clone.setAttribute('height', String(Math.round(1600 / whiteboardAspect)));
    const source = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `emtidad-board-${new Date().toISOString().slice(0, 10)}.svg`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input,textarea,select,[contenteditable=true]')) return;
      if (event.key === 'Escape') { setSelectedWhiteboardItem(null); setEditingWhiteboardText(null); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedWhiteboardItem) { event.preventDefault(); deleteWhiteboardItem(selectedWhiteboardItem); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectedWhiteboardItem) { event.preventDefault(); duplicateWhiteboardItem(); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedWhiteboardItem, whiteboardItems]);

  const startWhiteboardStroke = (event: PointerEvent<SVGSVGElement>) => {
    whiteboardPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (whiteboardPointersRef.current.size >= 2) {
      event.preventDefault();
      const points = [...whiteboardPointersRef.current.values()];
      const distance = Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
      const center = whiteboardPointFromClient(event.currentTarget, (points[0].clientX + points[1].clientX) / 2, (points[0].clientY + points[1].clientY) / 2);
      whiteboardPinchRef.current = { distance, center };
      whiteboardItemInteractionRef.current = null;
      panStartRef.current = null;
      const cancelledStroke = activeStrokeRef.current;
      if (cancelledStroke) sendWhiteboard({ kind: 'erase', ids: [cancelledStroke.id] });
      activeStrokeRef.current = null;
      setActiveStroke(null);
      return;
    }
    if (whiteboardTool === 'text') {
      addWhiteboardText(whiteboardPoint(event));
      return;
    }
    if (whiteboardTool === 'select') {
      setSelectedWhiteboardItem(null);
      setEditingWhiteboardText(null);
      return;
    }
    if (whiteboardTool === 'pan') {
      panStartRef.current = { clientX: event.clientX, clientY: event.clientY, x: whiteboardViewport.x, y: whiteboardViewport.y };
      return;
    }
    const next = { id: createWhiteboardId('stroke'), color: whiteboardColor, size: whiteboardSize, points: [whiteboardPoint(event)] };
    activeStrokeRef.current = next;
    liveStrokePointsRef.current = [];
    setActiveStroke(next);
    sendWhiteboard({ kind: 'stroke-start', stroke: { ...next, points: [...next.points] } });
  };

  const moveWhiteboardStroke = (event: PointerEvent<SVGSVGElement>) => {
    if (whiteboardPointersRef.current.has(event.pointerId)) whiteboardPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (whiteboardPointersRef.current.size >= 2) {
      event.preventDefault();
      const points = [...whiteboardPointersRef.current.values()];
      const distance = Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
      const previous = whiteboardPinchRef.current;
      if (previous?.distance && distance) zoomWhiteboard(distance / previous.distance, previous.center);
      const center = whiteboardPointFromClient(event.currentTarget, (points[0].clientX + points[1].clientX) / 2, (points[0].clientY + points[1].clientY) / 2);
      whiteboardPinchRef.current = { distance, center };
      return;
    }
    const itemInteraction = whiteboardItemInteractionRef.current;
    if (itemInteraction) {
      const point = whiteboardPoint(event);
      const deltaX = point.x - itemInteraction.start.x;
      const deltaY = point.y - itemInteraction.start.y;
      if (Math.hypot(deltaX, deltaY) > 4 / whiteboardViewport.zoom) itemInteraction.moved = true;
      const original = itemInteraction.item;
      let next: WhiteboardItem;
      if (itemInteraction.mode === 'move') {
        next = { ...original, x: original.x + deltaX, y: original.y + deltaY };
      } else if (original.type === 'image') {
        const ratio = original.width / original.height;
        const width = Math.max(80 / whiteboardViewport.zoom, original.width + deltaX);
        next = { ...original, width, height: width / ratio };
      } else {
        const scaleX = (original.width + deltaX) / original.width;
        const scaleY = (original.height + deltaY) / original.height;
        const scale = Math.max(0.35, Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY);
        next = { ...original, width: Math.max(160 / whiteboardViewport.zoom, original.width * scale), height: Math.max(70 / whiteboardViewport.zoom, original.height * scale), fontSize: Math.max(10 / whiteboardViewport.zoom, original.fontSize * scale) };
      }
      upsertWhiteboardItem(next);
      return;
    }
    if (whiteboardTool === 'pan' && panStartRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const viewWidth = 1000 / whiteboardViewport.zoom;
      const viewHeight = viewWidth / whiteboardAspect;
      const scaleX = viewWidth / rect.width;
      const scaleY = viewHeight / rect.height;
      setWhiteboardViewport({ ...whiteboardViewport, x: panStartRef.current.x - (event.clientX - panStartRef.current.clientX) * scaleX, y: panStartRef.current.y - (event.clientY - panStartRef.current.clientY) * scaleY });
      return;
    }
    if (!activeStrokeRef.current) return;
    const stroke = activeStrokeRef.current;
    const point = whiteboardPoint(event);
    const last = stroke.points.at(-1);
    if (last && (point.x - last.x) ** 2 + (point.y - last.y) ** 2 < MIN_STROKE_POINT_DISTANCE ** 2) return;
    const nextPoint = { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
    stroke.points.push(nextPoint);
    liveStrokePointsRef.current.push(nextPoint);
    if (stroke.points.length > MAX_STROKE_POINTS) stroke.points = stroke.points.filter((_, index) => index % 2 === 0);
    scheduleActiveStrokePaint();
    scheduleLiveStrokeBroadcast();
  };

  const finishWhiteboardStroke = (event?: PointerEvent<SVGSVGElement>) => {
    const wasPinching = whiteboardPinchRef.current !== null;
    if (event) whiteboardPointersRef.current.delete(event.pointerId);
    if (whiteboardPointersRef.current.size < 2) whiteboardPinchRef.current = null;
    if (wasPinching) return;
    const itemInteraction = whiteboardItemInteractionRef.current;
    if (itemInteraction) {
      whiteboardItemInteractionRef.current = null;
      const item = whiteboardItemsRef.current.find((candidate) => candidate.id === itemInteraction.id);
      if (item) {
        sendWhiteboard({ kind: 'item-upsert', item });
        if (item.type === 'text' && itemInteraction.mode === 'move' && !itemInteraction.moved) setEditingWhiteboardText(item.id);
      }
      return;
    }
    panStartRef.current = null;
    if (activeStrokeFrameRef.current !== null) {
      cancelAnimationFrame(activeStrokeFrameRef.current);
      activeStrokeFrameRef.current = null;
    }
    flushLiveStrokePoints();
    const finishedStroke = activeStrokeRef.current ? { ...activeStrokeRef.current, points: [...activeStrokeRef.current.points] } : null;
    activeStrokeRef.current = null;
    if (!finishedStroke) return;
    if (finishedStroke.points.length > 1) {
      setSyncedWhiteboardStrokes((current) => [...current, finishedStroke]);
      sendWhiteboard({ kind: 'stroke', stroke: finishedStroke });
    }
    setActiveStroke(null);
  };

  const clearWhiteboard = () => {
    if (role !== 'teacher') return;
    setSyncedWhiteboardStrokes([]);
    setSyncedWhiteboardItems([]);
    setSelectedWhiteboardItem(null);
    setEditingWhiteboardText(null);
    sendWhiteboard({ kind: 'clear' });
  };

  const undoWhiteboardAction = () => {
    const created = (id = '') => Number(id.split('-')[0]) || 0;
    const lastStroke = [...whiteboardStrokesRef.current].filter((stroke) => isOwnedWhiteboardId(stroke.id)).sort((left, right) => created(right.id) - created(left.id))[0];
    const lastItem = [...whiteboardItemsRef.current].filter((item) => isOwnedWhiteboardId(item.id)).sort((left, right) => created(right.id) - created(left.id))[0];
    if (!lastStroke && !lastItem) return;
    if (lastItem && (!lastStroke || created(lastItem.id) >= created(lastStroke.id))) {
      deleteWhiteboardItem(lastItem.id);
      return;
    }
    if (!lastStroke) return;
    setSyncedWhiteboardStrokes((current) => current.filter(stroke => stroke.id !== lastStroke.id));
    sendWhiteboard({ kind: 'erase', ids: [lastStroke.id] });
  };

  const whiteboardContentPoints = (strokes: WhiteboardStroke[], items: WhiteboardItem[]) => [
    ...strokes.flatMap((stroke) => stroke.points),
    ...items.flatMap((item) => [{ x: item.x, y: item.y }, { x: item.x + item.width, y: item.y + item.height }]),
  ];

  const fitWhiteboardToContent = (strokes: WhiteboardStroke[], items: WhiteboardItem[]) => {
    const aspect = getLiveWhiteboardAspect();
    const points = whiteboardContentPoints(strokes, items);
    if (!points.length) {
      setWhiteboardViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const padding = 110;
    const contentWidth = Math.max(240, maxX - minX + padding * 2);
    const contentHeight = Math.max(180, maxY - minY + padding * 2);
    const fittedWidth = Math.max(contentWidth, contentHeight * aspect);
    const fittedHeight = fittedWidth / aspect;
    const zoom = Math.max(MIN_WHITEBOARD_ZOOM, Math.min(MAX_WHITEBOARD_ZOOM, 1000 / fittedWidth));
    setWhiteboardViewport({
      x: minX - (fittedWidth - (maxX - minX)) / 2,
      y: minY - (fittedHeight - (maxY - minY)) / 2,
      zoom,
    });
  };

  const ensureWhiteboardContentVisible = (strokes: WhiteboardStroke[], items: WhiteboardItem[] = whiteboardItemsRef.current) => {
    const aspect = getLiveWhiteboardAspect();
    const points = whiteboardContentPoints(strokes, items);
    if (!points.length) return;
    setWhiteboardViewport((current) => {
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      const viewWidth = 1000 / current.zoom;
      const viewHeight = viewWidth / aspect;
      const padding = 70 / current.zoom;
      const inside = minX >= current.x + padding && maxX <= current.x + viewWidth - padding && minY >= current.y + padding && maxY <= current.y + viewHeight - padding;
      if (inside) return current;
      const contentWidth = Math.max(viewWidth, maxX - minX + padding * 2);
      const contentHeight = Math.max(viewHeight, maxY - minY + padding * 2);
      const fittedWidth = Math.max(contentWidth, contentHeight * aspect);
      const fittedHeight = fittedWidth / aspect;
      const zoom = Math.max(MIN_WHITEBOARD_ZOOM, Math.min(MAX_WHITEBOARD_ZOOM, 1000 / fittedWidth));
      return {
        x: minX - (fittedWidth - (maxX - minX)) / 2,
        y: minY - (fittedHeight - (maxY - minY)) / 2,
        zoom,
      };
    });
  };

  const zoomWhiteboard = (factor: number, anchor?: { x: number; y: number }) => {
    setWhiteboardViewport((current) => {
      const nextZoom = Math.max(MIN_WHITEBOARD_ZOOM, Math.min(MAX_WHITEBOARD_ZOOM, current.zoom * factor));
      const currentWidth = 1000 / current.zoom;
      const nextWidth = 1000 / nextZoom;
      const currentHeight = currentWidth / whiteboardAspect;
      const nextHeight = nextWidth / whiteboardAspect;
      if (anchor) {
        const ratioX = (anchor.x - current.x) / currentWidth;
        const ratioY = (anchor.y - current.y) / currentHeight;
        return { zoom: nextZoom, x: anchor.x - nextWidth * ratioX, y: anchor.y - nextHeight * ratioY };
      }
      return { zoom: nextZoom, x: current.x + (currentWidth - nextWidth) / 2, y: current.y + (currentHeight - nextHeight) / 2 };
    });
  };

  const stopWhiteboardZoomEvent = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleWhiteboardWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    updateWhiteboardAspect(event.currentTarget);
    zoomWhiteboard(event.deltaY > 0 ? 0.9 : 1.1, whiteboardPoint(event));
  };

  const viewWidth = 1000 / whiteboardViewport.zoom;
  const viewHeight = viewWidth / whiteboardAspect;

  const renderWhiteboardItem = (item: WhiteboardItem) => {
    const selected = selectedWhiteboardItem === item.id;
    const commonProps = {
      className: `whiteboard-item ${selected ? 'selected' : ''}`,
      onPointerDown: (event: PointerEvent<SVGGElement>) => startWhiteboardItemInteraction(event, item, 'move'),
    };
    return (
      <g key={item.id} {...commonProps} onDoubleClick={() => item.type === 'text' && setEditingWhiteboardText(item.id)}>
        {item.type === 'image' ? (
          <foreignObject x={item.x} y={item.y} width={item.width} height={item.height} opacity={item.opacity ?? 1}>
            <img className="whiteboard-board-image" draggable={false} src={item.src} alt="" style={{ objectFit: item.fit || 'contain', borderRadius: item.borderRadius || 0 }} />
          </foreignObject>
        ) : (
          <foreignObject x={item.x} y={item.y} width={item.width} height={item.height}>
            {editingWhiteboardText === item.id ? <textarea
              autoFocus
              className="whiteboard-text-editor"
              dir="auto"
              value={item.text}
              style={{ color: item.color, fontSize: item.fontSize, fontFamily: item.fontFamily, fontWeight: item.fontWeight, fontStyle: item.fontStyle, textAlign: item.textAlign, background: item.background, opacity: item.opacity ?? 1 }}
              placeholder={t('اكتب هنا')}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => upsertWhiteboardItem({ ...item, text: event.target.value }, true)}
              onBlur={() => { if (!item.text.trim()) deleteWhiteboardItem(item.id); else setEditingWhiteboardText(null); }}
            /> : <div className="whiteboard-text-content" dir="auto" style={{ color: item.color, fontSize: item.fontSize, fontFamily: item.fontFamily, fontWeight: item.fontWeight, fontStyle: item.fontStyle, textAlign: item.textAlign, background: item.background, opacity: item.opacity ?? 1 }}>{item.text || t('اكتب هنا')}</div>}
          </foreignObject>
        )}
        {selected && <>
          <rect className="whiteboard-selection-box" x={item.x} y={item.y} width={item.width} height={item.height} />
          <circle className="whiteboard-resize-handle" cx={item.x + item.width} cy={item.y + item.height} r={10 / whiteboardViewport.zoom} onPointerDown={(event) => startWhiteboardItemInteraction(event, item, 'resize')} />
        </>}
      </g>
    );
  };

  const renderWhiteboardTools = () => (
      <div className="whiteboard-tools" aria-label={t('أدوات اللوح')}>
        <span className="whiteboard-tool-heading">{t('أدوات اللوح')}</span>
        <button data-whiteboard-tool="select" className={whiteboardTool === 'select' ? 'selected tool-mode' : 'tool-mode'} type="button" onClick={() => setWhiteboardTool('select')} aria-label={t('تحديد وتحريك العناصر')} title={t('تحديد وتحريك العناصر')}><MousePointer2 size={17} /></button>
        <button data-whiteboard-tool="draw" className={whiteboardTool === 'draw' ? 'selected tool-mode' : 'tool-mode'} type="button" onClick={() => setWhiteboardTool('draw')} aria-label={t('الرسم بالقلم')} title={t('الرسم بالقلم')}><Pencil size={17} /></button>
        <button data-whiteboard-tool="pan" className={whiteboardTool === 'pan' ? 'selected tool-mode' : 'tool-mode'} type="button" onClick={() => setWhiteboardTool('pan')} aria-label={t("تحريك اللوح")} title={t("تحريك اللوح")}><Hand size={17} /></button>
        <button data-whiteboard-tool="text" className={whiteboardTool === 'text' ? 'selected tool-mode' : 'tool-mode'} type="button" onClick={() => setWhiteboardTool('text')} aria-label={t('إضافة نص')} title={t('إضافة نص')}><TypeIcon size={17} /></button>
        <button data-whiteboard-tool="image" className="tool-mode" type="button" onClick={() => whiteboardImageInputRef.current?.click()} aria-label={t('إضافة صورة')} title={t('إضافة صورة')}><ImagePlus size={17} /></button>
        <input ref={whiteboardImageInputRef} className="whiteboard-image-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleWhiteboardImageChange} />
        <button className="tool-mode" type="button" onClick={undoWhiteboardAction} aria-label={role === 'student' ? t('تراجع عن آخر إضافة لك') : t("تراجع خطوة")} title={role === 'student' ? t('تراجع عن آخر إضافة لك') : t("تراجع خطوة")}><Undo2 size={17} /></button>
        <button className="tool-mode" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { stopWhiteboardZoomEvent(event); zoomWhiteboard(1.2); }} aria-label={t("تكبير")}>+</button>
        <button className="tool-mode" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { stopWhiteboardZoomEvent(event); zoomWhiteboard(0.84); }} aria-label={t("تصغير")}>-</button>
        <button className="tool-mode" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { stopWhiteboardZoomEvent(event); fitWhiteboardToContent(whiteboardStrokesRef.current, whiteboardItemsRef.current); }} aria-label={t("إظهار كامل الرسم")} title={t("إظهار كامل الرسم")}><Maximize2 size={17} /></button>
        <span className="whiteboard-zoom-value">{Math.round(whiteboardViewport.zoom * 100)}%</span>
        <label className="whiteboard-color-picker" title={t('اختيار لون القلم')}><span style={{ background: whiteboardColor }} /><input aria-label={t('اختيار لون القلم')} type="color" value={whiteboardColor} onChange={event => setWhiteboardColor(event.target.value)} /></label>
        <label className="whiteboard-size-picker" title={t('حجم القلم')}><span>{whiteboardSize}</span><input aria-label={t("حجم القلم")} min="2" max="18" type="range" value={whiteboardSize} onChange={(event) => setWhiteboardSize(Number(event.target.value))} /></label>
        {selectedWhiteboardItem && <button className="whiteboard-delete-item" type="button" onClick={() => deleteWhiteboardItem(selectedWhiteboardItem)} title={t('حذف العنصر')} aria-label={t('حذف العنصر')}><Trash2 size={17} /></button>}
        <button className="tool-mode" type="button" onClick={downloadWhiteboard} title={t('تنزيل اللوح')} aria-label={t('تنزيل اللوح')}><Download size={17} /></button>
        {role === 'teacher' && <button className="whiteboard-clear" type="button" onClick={clearWhiteboard} title={t("مسح اللوح")}><Trash2 size={17} /></button>}
      </div>
  );

  const renderWhiteboard = () => (
    <div className="whiteboard-panel" aria-label={t('اللوح المشترك. يمكنك لصق صورة مباشرة باستخدام Ctrl+V')}>
      {selectedWhiteboardObject?.type === 'image' && <div className="whiteboard-inspector" onPointerDown={event => event.stopPropagation()}>
        <div className="whiteboard-inspector-title"><strong>{t('تنسيق الصورة')}</strong><small>{t('التغييرات تظهر للطرفين مباشرة')}</small></div>
          {selectedWhiteboardObject.documentPages && <div className="whiteboard-document-pages"><strong>{selectedWhiteboardObject.documentName}</strong><span>{t('صفحة {v0} من {v1}', { v0: selectedWhiteboardObject.documentPage || 1, v1: selectedWhiteboardObject.documentPages })}</span>{whiteboardDocument?.itemId === selectedWhiteboardObject.id && <div><button type="button" disabled={whiteboardDocumentBusy || whiteboardDocument.page <= 1} onClick={() => void changeWhiteboardDocumentPage(-1)} aria-label={t('الصفحة السابقة')}><ChevronRight size={16} /></button><button type="button" disabled={whiteboardDocumentBusy || whiteboardDocument.page >= whiteboardDocument.pages} onClick={() => void changeWhiteboardDocumentPage(1)} aria-label={t('الصفحة التالية')}><ChevronLeft size={16} /></button></div>}</div>}
          <div className="whiteboard-inspector-buttons"><button type="button" className={(selectedWhiteboardObject.fit || 'contain') === 'contain' ? 'selected' : ''} onClick={() => updateSelectedWhiteboardItem({ fit: 'contain' })}>{t('احتواء')}</button><button type="button" className={selectedWhiteboardObject.fit === 'cover' ? 'selected' : ''} onClick={() => updateSelectedWhiteboardItem({ fit: 'cover' })}>{t('ملء الإطار')}</button></div>
          <label className="whiteboard-range-field"><span>{t('استدارة الحواف')}</span><input type="range" min="0" max="80" value={selectedWhiteboardObject.borderRadius || 0} onChange={event => updateSelectedWhiteboardItem({ borderRadius: Number(event.target.value) })} /></label>
          <button type="button" onClick={() => whiteboardImageInputRef.current?.click()}><ImagePlus size={16} />{t('إضافة صورة أخرى')}</button>
        <label className="whiteboard-range-field"><span>{t('الشفافية')}</span><input type="range" min="20" max="100" value={Math.round((selectedWhiteboardObject.opacity ?? 1) * 100)} onChange={event => updateSelectedWhiteboardItem({ opacity: Number(event.target.value) / 100 })} /></label>
        <div className="whiteboard-inspector-actions"><button type="button" onClick={duplicateWhiteboardItem}><Copy size={16} />{t('نسخ')}</button><button type="button" onClick={() => moveWhiteboardLayer('front')} title={t('إلى الأمام')}><BringToFront size={16} /></button><button type="button" onClick={() => moveWhiteboardLayer('back')} title={t('إلى الخلف')}><SendToBack size={16} /></button><button className="danger" type="button" onClick={() => deleteWhiteboardItem(selectedWhiteboardObject.id)}><Trash2 size={16} /></button></div>
      </div>}
      <svg ref={whiteboardSvgRef} className={`whiteboard-canvas tool-${whiteboardTool} ${whiteboardTool === 'pan' ? 'panning' : ''}`} viewBox={`${whiteboardViewport.x} ${whiteboardViewport.y} ${viewWidth} ${viewHeight}`} preserveAspectRatio="none" onWheel={handleWhiteboardWheel} onPointerDown={startWhiteboardStroke} onPointerMove={moveWhiteboardStroke} onPointerUp={finishWhiteboardStroke} onPointerCancel={finishWhiteboardStroke}>
        {whiteboardItems.map(renderWhiteboardItem)}
        {[...whiteboardStrokes, ...(activeStroke ? [activeStroke] : [])].map((stroke) => <WhiteboardStrokePath key={stroke.id} stroke={stroke} />)}
      </svg>
    </div>
  );

  const publishDocumentAnnotations = (annotations: DocumentAnnotation[], immediate = false) => {
    documentAnnotationsRef.current = annotations;
    setDocumentAnnotations(annotations);
    if (documentBroadcastFrameRef.current !== null) cancelAnimationFrame(documentBroadcastFrameRef.current);
    if (immediate) { sendWhiteboard({ kind: 'document-annotations', annotations }); return; }
    documentBroadcastFrameRef.current = requestAnimationFrame(() => {
      documentBroadcastFrameRef.current = null;
      sendWhiteboard({ kind: 'document-annotations', annotations: documentAnnotationsRef.current });
    });
  };

  const documentPoint = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const transformed = point.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const startDocumentAnnotation = (event: PointerEvent<SVGSVGElement>) => {
    if (!sharedDocument) return;
    const point = documentPoint(event);
    if (documentTool === 'text') {
      const text = window.prompt(t('اكتب النص الذي تريد إضافته'))?.trim();
      if (!text) return;
      const next = [...documentAnnotationsRef.current, { id: createWhiteboardId('document-text'), page: sharedDocument.page, kind: 'text' as const, color: documentColor, x: point.x, y: point.y, text: text.slice(0, 500) }];
      publishDocumentAnnotations(next, true);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const annotation: DocumentAnnotation = { id: createWhiteboardId(`document-${documentTool}`), page: sharedDocument.page, kind: documentTool, color: documentColor, size: documentTool === 'highlight' ? 26 : 4, points: [point] };
    documentDrawingRef.current = annotation;
    publishDocumentAnnotations([...documentAnnotationsRef.current, annotation]);
  };

  const moveDocumentAnnotation = (event: PointerEvent<SVGSVGElement>) => {
    const active = documentDrawingRef.current;
    if (!active || active.kind === 'text') return;
    const point = documentPoint(event);
    const last = active.points.at(-1);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
    const updated: DocumentAnnotation = { ...active, points: [...active.points, point] };
    documentDrawingRef.current = updated;
    publishDocumentAnnotations(documentAnnotationsRef.current.map(item => item.id === updated.id ? updated : item));
  };

  const finishDocumentAnnotation = (event: PointerEvent<SVGSVGElement>) => {
    if (!documentDrawingRef.current) return;
    documentDrawingRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer can already be released. */ }
    publishDocumentAnnotations(documentAnnotationsRef.current, true);
  };

  const undoDocumentAnnotation = () => {
    let index = -1;
    for (let itemIndex = documentAnnotationsRef.current.length - 1; itemIndex >= 0; itemIndex -= 1) {
      if (role === 'teacher' || documentAnnotationsRef.current[itemIndex].id.includes(`-${role}-`)) { index = itemIndex; break; }
    }
    if (index < 0) return;
    publishDocumentAnnotations(documentAnnotationsRef.current.filter((_, itemIndex) => itemIndex !== index), true);
  };

  const documentPath = (annotation: Extract<DocumentAnnotation, { kind: 'pen' | 'highlight' }>) => annotation.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');

  const renderTile = (id: 'local' | 'remote', variant: 'grid' | 'focus' | 'pip' = 'grid') => {
    const isLocal = id === 'local';
    const name = isLocal ? localName : remoteName;
    const source: VideoSource = isLocal ? (isScreenSharing ? 'screen' : 'camera') : remoteVideoSource;
    const hasStream = isLocal ? isConnected : hasRemoteStream;
    const showVideo = hasStream && (isLocal ? videoEnabled || isScreenSharing : remoteVideoSource === 'screen' || remoteVideoEnabled);
    const ratio = videoRatios[id];
    return (
      <button className={`participant-tile ${variant} ${fitMode === 'fill' ? 'fill-frame' : 'fit-video'} ${source === 'screen' ? 'screen' : ''} ${ratio < 1 ? 'portrait-video' : 'landscape-video'} ${focusedParticipant === id ? 'selected' : ''} ${(isLocal ? localSpeaking : remoteSpeaking) ? 'speaking' : ''}`} type="button" onClick={() => { setStageMode('video'); setFocusedParticipant(current => current === id ? null : id); }} aria-label={focusedParticipant === id ? t('العودة إلى العرض الشبكي') : t("تكبير {v0}", { v0: name })} style={{ '--video-ratio': String(ratio) } as CSSProperties}>
        <video ref={isLocal ? bindLocalVideo : bindRemoteVideo} autoPlay muted={isLocal} playsInline onLoadedMetadata={(event) => updateVideoRatio(id, event.currentTarget)} onResize={(event) => updateVideoRatio(id, event.currentTarget)} className={source === 'camera' ? 'mirrored-video' : undefined} />
        {!showVideo && <div className="camera-placeholder" aria-hidden="true"><span>{name.slice(0, 1)}</span><strong>{hasStream ? name : t("بانتظار الدخول")}</strong><small>{hasStream ? t("الكاميرا مغلقة") : t("{v0} لم يدخل بعد", { v0: remoteName })}</small></div>}
        <div className="participant-meta"><span>{name}{isLocal ? t(" - أنت") : ''}</span>{isLocal && !audioEnabled && <MicOff size={15} aria-label={t("المايك مغلق")} />}{!showVideo && <CameraOff size={15} aria-label={t("الكاميرا مغلقة")} />}{source === 'screen' && <ScreenShare size={15} aria-label={t("مشاركة شاشة")} />}</div>
      </button>
    );
  };

  const openVideoMode = () => {
    setStageMode('video');
    setFocusedParticipant(null);
    setShowMore(false);
  };

  const toggleWhiteboard = () => {
    if (role !== 'teacher') return;
    const nextMode: StageMode = stageMode === 'whiteboard' ? 'video' : 'whiteboard';
    setStageMode(nextMode);
    sendWhiteboard({ kind: 'mode', mode: nextMode });
    setFocusedParticipant(null);
    setSidePanel(null);
    setShowMore(false);
  };
  return (
    <section className={`video-room call-experience ${compact ? 'compact-call' : ''} ${focusedParticipant ? 'focus-mode' : 'grid-mode'} ${sidePanel === 'participants' ? 'panel-open' : ''} ${sidePanel === 'chat' ? 'chat-open' : ''} ${stageMode === 'whiteboard' ? 'whiteboard-mode' : stageMode === 'document' ? 'document-mode' : 'video-mode'}`}>
      {role === 'teacher' && <input ref={whiteboardFileInputRef} data-whiteboard-file-input className="whiteboard-image-input call-file-input" type="file" accept="application/pdf,.pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,.ppt,.pptx,image/jpeg,image/png,image/webp,image/gif,text/plain,text/markdown,text/csv,application/json,.txt,.md,.csv,.json" onChange={handleWhiteboardFileChange} />}
      {!compact && navigationItems.length > 0 && <div className={`call-site-navigation ${siteMenuOpen ? 'open' : ''}`} onMouseLeave={() => setSiteMenuOpen(false)}><button className="call-menu-trigger" type="button" aria-label={t("فتح صفحات المنصة")} aria-expanded={siteMenuOpen} onMouseEnter={() => setSiteMenuOpen(true)} onClick={() => setSiteMenuOpen(value => !value)}><Menu size={22} /></button><nav aria-label={t("صفحات المنصة")}><strong>{t("تصفح المنصة")}</strong><PreferenceControls />{navigationItems.map(item => <button type="button" key={item.id} onClick={() => { setSiteMenuOpen(false); onNavigate?.(item.id); }}>{item.label}</button>)}</nav></div>}
      {compact && <div className="compact-call-header"><button className="call-expand-button" type="button" onClick={onExpand} title={t("العودة إلى المكالمة الكاملة")}><Maximize2 size={17} />{t("تكبير")}</button></div>}

      <div className="session-controls call-start">
        {isJoining && <span className="call-joining"><RefreshCw size={16} />{t("جار الانضمام")}</span>}
        {!isConnected && !isJoining && <button className="primary-button" type="button" onClick={startCall}><RefreshCw size={18} />{t("إعادة المحاولة")}</button>}
      </div>
      {showScreenShareNotice && <div className="unsupported-share-panel" role="status"><div><strong>{t('المشاركة أو النافذة العائمة غير متاحة على هذا المتصفح')}</strong><p>{t('حدّث المتصفح أو جرّب Chrome. إذا كان هاتفك يدعم المشاركة والنافذة العائمة ستبقى الحصة ظاهرة أثناء انتقالك بين التطبيقات.')}</p></div><button className="secondary-button" type="button" onClick={() => setShowScreenShareNotice(false)}>{t('حسناً')}</button></div>}

      <div className="call-stage">
        {stageMode === 'whiteboard' ? (
          <div className="whiteboard-stage">
            <aside className="whiteboard-side-rail"><div className="call-video-strip whiteboard-dock">{renderTile('local', 'pip')}{renderTile('remote', 'pip')}</div>{renderWhiteboardTools()}</aside>
            {renderWhiteboard()}
          </div>
        ) : stageMode === 'document' && sharedDocument ? (
          <div className="document-stage">
            <aside className="document-side-rail"><div className="call-video-strip whiteboard-dock">{renderTile('local', 'pip')}{renderTile('remote', 'pip')}</div><div className="document-slide-list" aria-label={t('صفحات الملف')}>{Array.from({ length: sharedDocument.pages }, (_, index) => index + 1).map(page => <button type="button" key={page} className={page === sharedDocument.page ? 'active' : ''} disabled={role !== 'teacher' || whiteboardDocumentBusy} onClick={() => void publishSharedDocumentPage(page)}><span>{page}</span></button>)}</div></aside>
            <section className="document-viewer" aria-label={t('عارض الملف')}><header><div><FileUp size={20} /><strong title={sharedDocument.name}>{sharedDocument.name}</strong><span>{t('صفحة {v0} من {v1}', { v0: sharedDocument.page, v1: sharedDocument.pages })}</span></div><div className="document-annotation-tools" aria-label={t('أدوات التعليق على الملف')}><button type="button" className={documentTool === 'pen' ? 'active' : ''} onClick={() => setDocumentTool('pen')} title={t('قلم')}><Pencil size={17} /></button><button type="button" className={documentTool === 'highlight' ? 'active' : ''} onClick={() => setDocumentTool('highlight')} title={t('هايلايتر')}><Highlighter size={17} /></button><button type="button" className={documentTool === 'text' ? 'active' : ''} onClick={() => setDocumentTool('text')} title={t('إضافة نص')}><TypeIcon size={17} /></button><label title={t('لون الأداة')}><span style={{ background: documentColor }} /><input type="color" value={documentColor} onChange={event => setDocumentColor(event.target.value)} /></label><button type="button" onClick={undoDocumentAnnotation} title={t('تراجع')}><Undo2 size={17} /></button></div><nav><button type="button" disabled={role !== 'teacher' || whiteboardDocumentBusy || sharedDocument.page <= 1} onClick={() => changeSharedDocumentPage(-1)} aria-label={t('الصفحة السابقة')}><ChevronRight size={20} /></button><button type="button" disabled={role !== 'teacher' || whiteboardDocumentBusy || sharedDocument.page >= sharedDocument.pages} onClick={() => changeSharedDocumentPage(1)} aria-label={t('الصفحة التالية')}><ChevronLeft size={20} /></button>{role === 'teacher' && <button type="button" className="document-close" onClick={closeSharedDocument} aria-label={t('إغلاق الملف')}>×</button>}</nav></header><div className="document-page"><div className="document-page-canvas"><img src={sharedDocument.src} alt={t('صفحة {v0} من {v1}', { v0: sharedDocument.page, v1: sharedDocument.pages })} /><svg viewBox="0 0 1000 1400" preserveAspectRatio="none" onPointerDown={startDocumentAnnotation} onPointerMove={moveDocumentAnnotation} onPointerUp={finishDocumentAnnotation} onPointerCancel={finishDocumentAnnotation}>{documentAnnotations.filter(item => item.page === sharedDocument.page).map(item => item.kind === 'text' ? <text key={item.id} x={item.x} y={item.y} fill={item.color} fontSize="34" fontWeight="700" paintOrder="stroke" stroke="#fff" strokeWidth="3">{item.text}</text> : <path key={item.id} d={documentPath(item)} fill="none" stroke={item.color} strokeWidth={item.size} strokeLinecap="round" strokeLinejoin="round" opacity={item.kind === 'highlight' ? .42 : 1} />)}</svg></div></div></section>
          </div>
        ) : (
          <div className="video-grid" aria-label={t("المشاركون")}>
            {focusedParticipant ? <>{renderTile(focusedParticipant, 'focus')}<div className="floating-preview" style={{ '--video-ratio': String(videoRatios[focusedParticipant === 'local' ? 'remote' : 'local']) } as CSSProperties}>{renderTile(focusedParticipant === 'local' ? 'remote' : 'local', 'pip')}</div></> : <>{renderTile('remote')}{renderTile('local')}</>}
          </div>
        )}
        {sidePanel === 'participants' && <aside className="call-side-panel" aria-label={t("المشاركون")}><div className="panel-title"><strong>{t("المشاركون")}</strong><button type="button" onClick={() => setSidePanel(null)} aria-label={t("إغلاق")}>×</button></div><div className="participant-list"><span>{localName}{t(" - أنت")}</span><span>{hasRemoteStream ? remoteName : t("{v0} بانتظار الدخول", { v0: remoteName })}</span></div></aside>}
      </div>

      <div className="call-toolbar" aria-label={t("أدوات المكالمة")}>
        <button className={audioEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleAudioToggle} title={audioEnabled ? t("إيقاف المايك") : t("تشغيل المايك")} type="button">{audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}</button>
        <button className={videoEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleVideoToggle} title={videoEnabled ? t("إيقاف الكاميرا") : t("تشغيل الكاميرا")} type="button">{videoEnabled ? <Camera size={20} /> : <CameraOff size={20} />}</button>
        <button className={isScreenSharing ? 'tool-button active-share' : 'tool-button'} disabled={!isConnected} onClick={handleScreenShareToggle} title={isScreenSharing ? t("إيقاف مشاركة الشاشة") : t("مشاركة الشاشة")} type="button">{isScreenSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}</button>
        <button className={stageMode === 'document' ? 'tool-button file-share-button active-share' : 'tool-button file-share-button'} disabled={role !== 'teacher' || whiteboardDocumentBusy} onClick={() => whiteboardFileInputRef.current?.click()} title={role === 'teacher' ? t('عرض ملف كشرائح') : t('رفع الملف بتحكم الأستاذ')} type="button"><FileUp size={20} /><span>{t('ملف')}</span></button>
        <button className={stageMode === 'whiteboard' ? 'tool-button active-share' : 'tool-button'} disabled={role !== 'teacher'} onClick={toggleWhiteboard} title={role === 'teacher' ? t("اللوح المشترك") : t("اللوح بتحكم الأستاذ")} type="button"><Grid2X2 size={20} /></button>
        <button className={sidePanel === 'chat' ? 'tool-button active-share call-chat-tool' : 'tool-button call-chat-tool'} onClick={() => { if (sidePanel === 'chat') updateLocalTyping(false); setSidePanel(sidePanel === 'chat' ? null : 'chat'); setUnreadCallMessages(0); setShowMore(false); }} title={t("المحادثة")} type="button"><MessageSquare size={20} />{unreadCallMessages > 0 && <span className="call-unread-badge" aria-label={t('{v0} رسائل جديدة', { v0: unreadCallMessages })}>{unreadCallMessages > 9 ? '9+' : unreadCallMessages}</span>}</button>
        {installPrompt && <button className="tool-button" onClick={handleInstallApp} title={t("تثبيت كتطبيق")} type="button"><Download size={20} /></button>}
        <button className={showMore ? 'tool-button active-share' : 'tool-button'} onClick={() => setShowMore(!showMore)} title={t("خيارات أكثر")} type="button"><MoreHorizontal size={20} /></button>
        <button className="tool-button danger" onClick={endCall} title={t("إنهاء المكالمة والخروج")} type="button"><PhoneOff size={20} /></button>
        {showMore && <div className="call-more-menu"><button type="button" onClick={() => { setSidePanel(sidePanel === 'participants' ? null : 'participants'); setShowMore(false); }}><Users size={17} />{t("المشاركون")}</button><button type="button" onClick={openVideoMode}><Grid2X2 size={17} />{t("عرض الفيديو")}</button><button type="button" onClick={() => setFitMode(fitMode === 'fit' ? 'fill' : 'fit')}><MoreHorizontal size={17} />{fitMode === 'fit' ? t('ملء إطار الفيديو') : t('احتواء الفيديو')}</button><button type="button" disabled={!isConnected} onClick={handlePictureInPictureToggle}><PictureInPicture2 size={17} />{t("نافذة عائمة")}</button></div>}
      </div>

      {mutedSpeechWarning && <button type="button" className="muted-speaking-warning" onClick={handleAudioToggle}><MicOff size={18} /><span><strong>{t('يبدو أنك تتحدث والمايك مغلق')}</strong><small>{t('اضغط هنا لفك الميوت')}</small></span></button>}
      {remainingGrace !== null && remainingGrace > 0 && <div className="lesson-grace-countdown" role="alert"><Clock3 size={18} /><span>{t('انتهى وقت الحصة. سيتم إغلاق الغرفة خلال')}</span><strong dir="ltr">{String(Math.floor(remainingGrace / 60000)).padStart(2, '0')}:{String(Math.floor(remainingGrace / 1000) % 60).padStart(2, '0')}</strong></div>}

      {sidePanel === 'chat' && <aside className="call-chat-drawer" aria-label={t("المحادثة")}>
        <div className="call-chat-head"><div><MessageSquare size={18} /><strong>{t("محادثة الحصة")}</strong><span>{t("تصل للطرف الآخر مباشرة")}</span></div><button type="button" onClick={() => { updateLocalTyping(false); setSidePanel(null); }} aria-label={t("إغلاق المحادثة")}>×</button></div>
        <div className="call-chat-messages">
          {!messages.length && !remoteTyping && <p className="call-chat-empty">{t("ابدأ المحادثة أثناء المكالمة.")}</p>}
          {messages.map(message => <article key={message.id}><header><strong>{message.name}</strong><time>{new Date(message.created).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</time></header><p>{message.body}</p></article>)}
          {remoteTyping && <div className="call-typing-indicator" role="status" aria-label={t("{v0} يكتب", { v0: remoteName })}><span /><span /><span /></div>}
          <div ref={chatEndRef} />
        </div>
        <form className="call-chat-compose" onSubmit={sendChatMessage}><input aria-label={t("رسالة جديدة")} value={chatDraft} onChange={event => { setChatDraft(event.target.value); updateLocalTyping(Boolean(event.target.value.trim())); }} onBlur={() => updateLocalTyping(false)} placeholder={t("اكتب رسالة…")} maxLength={2000} disabled={!onSendMessage || chatSending} /><button type="submit" disabled={!chatDraft.trim() || !onSendMessage || chatSending} aria-label={t("إرسال الرسالة")}><MessageSquare size={18} /></button></form>
      </aside>}
    </section>
  );
}
