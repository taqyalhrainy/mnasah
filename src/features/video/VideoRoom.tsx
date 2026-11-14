import { constrainDocumentView, fitDocumentView, zoomDocumentView } from './documentViewport';
import { DocumentPageCache } from './documentPageCache';
import { whiteboardPng, downloadBoardImage } from './whiteboardExport';
import { BoardImagePreview } from './BoardImagePreview';
import { SharedYoutube, YoutubeLinkDialog, validYoutubeSession, type YoutubeSession } from './SharedYoutube';
import { t, locale, usePreferences, PreferenceControls } from '../../i18n/preferences';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent, PointerEvent, WheelEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { BringToFront, Camera, CameraOff, SwitchCamera, ChevronLeft, ChevronRight, Clock3, Copy, Download, FileUp, Grid2X2, Hand, Highlighter, ImagePlus, Maximize2, Menu, MessageSquare, Mic, MicOff, MoreHorizontal, MousePointer2, Pencil, PhoneOff, PictureInPicture2, RefreshCw, ScreenShare, ScreenShareOff, SendToBack, Trash2, Type as TypeIcon, Undo2, Users, X } from 'lucide-react';
import { VideoConnection, VideoRole, VideoSource } from '../../services/videoConnection';
import { apiMediaUrl, requestFile } from '../../services/platformApi';

const MIN_WHITEBOARD_ZOOM = 0.005;
const MAX_WHITEBOARD_ZOOM = 5;
const MIN_STROKE_POINT_DISTANCE = 1.5;
const MAX_STROKE_POINTS = 1200;
const LIVE_STROKE_BROADCAST_INTERVAL_MS = 32;

function splitDocumentText(text: string) {
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!; context.font = '24px Arial';
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (context.measureText(line + character).width > 860) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  const pages: string[] = [];
  for (let index = 0; index < lines.length; index += 31) pages.push(lines.slice(index, index + 31).join('\n'));
  return pages.length ? pages : [''];
}

function textDocumentPage(text: string, title = '') {
  const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 1400;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, 1000, 1400);
  context.fillStyle = '#24212b'; context.font = '24px Arial';
  let y = 65;
  for (const paragraph of `${title ? `${title}\n\n` : ''}${text}`.split('\n')) {
    const rtl = /[\u0600-\u06ff]/.test(paragraph); context.direction = rtl ? 'rtl' : 'ltr'; context.textAlign = rtl ? 'right' : 'left';
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (context.measureText(`${line} ${word}`).width > 870 && line) { context.fillText(line, rtl ? 940 : 60, y); y += 38; line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    context.fillText(line, rtl ? 940 : 60, y); y += 38;
  }
  const src = canvas.toDataURL('image/webp', .9); canvas.width = 1; canvas.height = 1; return src;
}

async function rasterizeSlide(src: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(t('تعذر فتح صفحة الملف.'))); image.src = src; });
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const output = canvas.toDataURL('image/webp', .9); canvas.width = 1; canvas.height = 1; return output;
}

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener: (type: 'release', listener: () => void) => void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> };
type WhiteboardPoint = { x: number; y: number };
type WhiteboardStroke = { id: string; color: string; size: number; points: WhiteboardPoint[] };
type WhiteboardBaseItem = { id: string; x: number; y: number; width: number; height: number; opacity?: number };
type WhiteboardTextItem = WhiteboardBaseItem & { type: 'text'; text: string; color: string; fontSize: number; fontFamily?: string; fontWeight?: number; fontStyle?: 'normal' | 'italic'; textAlign?: 'start' | 'center' | 'end'; background?: string };
type WhiteboardImageItem = WhiteboardBaseItem & { type: 'image'; src: string; fit?: 'contain' | 'cover'; borderRadius?: number; documentName?: string; documentPage?: number; documentPages?: number };
type WhiteboardItem = WhiteboardTextItem | WhiteboardImageItem;
type SharedDocument = { id?: string; name: string; page: number; pages: number; src: string; fileUrl?: string; format: 'pdf' | 'presentation' | 'image' | 'text' | 'file' };
type DocumentPoint = { x: number; y: number };
type DocumentAnnotation = { id: string; page: number; kind: 'pen' | 'highlight'; color: string; size: number; points: DocumentPoint[] } | { id: string; page: number; kind: 'text'; color: string; x: number; y: number; text: string };
type SharedPointer = { x: number; y: number; space: 'whiteboard' | 'document'; page?: number };
type SharedDocumentView = { documentId: string; page: number; zoom: number; x: number; y: number };
type WhiteboardMessage =
  | { kind: 'sync-request' }
  | { kind: 'pointer'; pointer: SharedPointer | null }
  | { kind: 'stroke-start'; stroke: WhiteboardStroke }
  | { kind: 'stroke-points'; id: string; points: WhiteboardPoint[] }
  | { kind: 'stroke'; stroke: WhiteboardStroke }
  | { kind: 'clear' }
  | { kind: 'erase'; ids: string[] }
  | { kind: 'item-upsert'; item: WhiteboardItem }
  | { kind: 'item-delete'; id: string }
  | { kind: 'mode'; mode: StageMode }
  | { kind: 'board-session'; open: boolean }
  | { kind: 'document'; document: SharedDocument | null }
  | { kind: 'document-preload'; id: string; page: number; src: string }
  | { kind: 'document-view'; view: SharedDocumentView }
  | { kind: 'document-annotations'; annotations: DocumentAnnotation[] }
  | { kind: 'youtube'; session: YoutubeSession | null }
  | { kind: 'sync'; strokes: WhiteboardStroke[]; items?: WhiteboardItem[]; mode?: StageMode; boardOpen?: boolean; document?: SharedDocument | null; documentView?: SharedDocumentView; annotations?: DocumentAnnotation[]; youtube?: YoutubeSession | null };
type StageMode = 'video' | 'whiteboard' | 'document' | 'youtube';
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
  onPresenceChange?: (active: boolean, peerId?: string | null, joining?: boolean) => Promise<unknown>;
  getRemotePeerId?: () => Promise<string | null | undefined>;
  initialRemotePeerId?: string | null;
  remotePresent?: boolean;
  onLeave?: () => void;
  navigationItems?: Array<{ id: string; label: string }>;
  onNavigate?: (id: string) => void;
  compact?: boolean;
  onExpand?: () => void;
  currentUserId?: string;
  lessonId?: string;
  displayName?: string;
  avatarUrl?: string;
  scheduledEnd?: number;
  onGraceExpired?: () => Promise<void> | void;
};

const WhiteboardStrokePath = memo(function WhiteboardStrokePath({ stroke }: { stroke: WhiteboardStroke }) {
  if (stroke.points.length === 1) return <circle className="whiteboard-dot" cx={stroke.points[0].x} cy={stroke.points[0].y} r={stroke.size} fill={stroke.color} pointerEvents="none" />;
  const path = stroke.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return <path d={path} fill="none" stroke={stroke.color} strokeWidth={stroke.size * 2} strokeLinecap="round" strokeLinejoin="round" />;
});

declare global { interface Window { mansahCallActive?: boolean } }

function callMediaPreference(room: string, role: VideoRole) {
  try { return JSON.parse(sessionStorage.getItem(`lesson-media:${room}:${role}`) || '{}') as { audio?: boolean; video?: boolean }; }
  catch { return {}; }
}

export function VideoRoom({ assignedRole: role, assignedRoom: roomId, authorize, messages = [], onSendMessage, onPresenceChange, getRemotePeerId, initialRemotePeerId, remotePresent, onLeave, navigationItems = [], onNavigate, compact = false, onExpand, currentUserId, lessonId, displayName, avatarUrl, scheduledEnd, onGraceExpired }: VideoRoomProps) {
  usePreferences();
  const [mediaError, setMediaError] = useState('');
  const mediaErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setStatus = useCallback((message: string) => {
    const error = /تعذر|خطأ|فشل|error|fail|unable|cannot|can't|could not|couldn.t|denied/i.test(message) ? message : '';
    if (!error) return;
    clearTimeout(mediaErrorTimer.current);
    setMediaError(error);
    mediaErrorTimer.current = setTimeout(() => setMediaError(''), 5000);
  }, []);
  useEffect(() => () => clearTimeout(mediaErrorTimer.current), []);
  const [boardExporting, setBoardExporting] = useState(false);
  const [boardImage, setBoardImage] = useState<File | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(() => callMediaPreference(roomId, role).audio !== false);
  const [videoEnabled, setVideoEnabled] = useState(() => callMediaPreference(roomId, role).video === true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showScreenShareNotice, setShowScreenShareNotice] = useState(false);
  const [remoteVideoSource, setRemoteVideoSource] = useState<VideoSource>('camera');
  const [remoteVideoEnabled, setRemoteVideoEnabled] = useState(false);
  const [remoteAudioEnabled, setRemoteAudioEnabled] = useState(true);
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState(0);
  const [reportedRemotePresent, setReportedRemotePresent] = useState<boolean | null>(() => remotePresent ?? (initialRemotePeerId ? true : null));
  useEffect(() => { if (remotePresent !== undefined) setReportedRemotePresent(remotePresent); }, [remotePresent]);
  const [focusedParticipant, setFocusedParticipant] = useState<'local' | 'remote' | 'local-screen' | 'remote-screen' | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const localScreenRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<HTMLVideoElement>(null);
  const [stageMode, setStageMode] = useState<StageMode>('video');
  const [boardOpen, setBoardOpen] = useState(false);
  const boardOpenRef = useRef(false);
  const updateBoardOpen = (open: boolean) => { boardOpenRef.current = open; setBoardOpen(open); };
  const [sidePanel, setSidePanel] = useState<'participants' | 'chat' | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [youtubeLinkOpen, setYoutubeLinkOpen] = useState(false);
  const [youtubeSession, setYoutubeSession] = useState<YoutubeSession | null>(null);
  const youtubeRef = useRef<YoutubeSession | null>(null);
  const updateYoutube = (session: YoutubeSession | null, broadcast = false) => {
    if (broadcast && session === null && role !== 'teacher') return;
    if (session && !validYoutubeSession(session)) return;
    const previous = youtubeRef.current;
    youtubeRef.current = session; setYoutubeSession(session);
    if (session && session.videoId !== previous?.videoId) { setStageMode('youtube'); setFocusedParticipant(null); }
    if (!session && stageModeRef.current === 'youtube') setStageMode('video');
    if (broadcast) connectionRef.current?.sendWhiteboard({ kind: 'youtube', session });
  };
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [mutedSpeechWarning, setMutedSpeechWarning] = useState(false);
  const [unreadCallMessages, setUnreadCallMessages] = useState(0);
  const [remoteAudioBlocked, setRemoteAudioBlocked] = useState(false);
  const [remainingGrace, setRemainingGrace] = useState<number | null>(null);
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [fitMode, setFitMode] = useState<'fit' | 'fill'>('fit');
  const [videoRatios, setVideoRatios] = useState({ local: 16 / 9, remote: 16 / 9 });
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');
  const [cameraSwitching, setCameraSwitching] = useState(false);
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
  const [mobileTextDraft, setMobileTextDraft] = useState('');
  const mobileTextDialogRef = useRef<HTMLDialogElement | null>(null);
  const ignoreEditorOpeningClickRef = useRef(false);
  const [imageOptionsOpen, setImageOptionsOpen] = useState(false);
  const mobileWhiteboard = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  useEffect(() => {
    if (!mobileWhiteboard || !editingWhiteboardText) return;
    const viewport = window.visualViewport;
    const resize = () => { const node = mobileTextDialogRef.current; if (!node) return; const height = viewport?.height || window.innerHeight; node.style.setProperty('--wb-editor-height', `${height}px`); node.style.setProperty('--wb-editor-top', `${(viewport?.offsetTop || 0) + height / 2}px`); };
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    return () => { viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); };
  }, [mobileWhiteboard, editingWhiteboardText]);
  const pendingTextPointRef = useRef<WhiteboardPoint | null>(null);
  const desktopTextEditTimerRef = useRef<number | null>(null);
  useEffect(() => setImageOptionsOpen(false), [selectedWhiteboardItem]);
  const [whiteboardDocument, setWhiteboardDocument] = useState<WhiteboardDocument | null>(null);
  const [whiteboardDocumentBusy, setWhiteboardDocumentBusy] = useState(false);
  const [sharedDocument, setSharedDocument] = useState<SharedDocument | null>(null);
  const [documentTool, setDocumentTool] = useState<'pen' | 'highlight' | 'pan' | 'pointer'>('pen');
  const [documentColor, setDocumentColor] = useState('#facc15');
  const [documentAnnotations, setDocumentAnnotations] = useState<DocumentAnnotation[]>([]);
  const [localPointer, setLocalPointer] = useState<SharedPointer | null>(null);
  const [remotePointer, setRemotePointer] = useState<SharedPointer | null>(null);
  const pointerSentRef = useRef(0);
  const pointerTimerRef = useRef<number | null>(null);
  const documentPageRef = useRef<HTMLDivElement>(null);
  const [documentSize, setDocumentSize] = useState({ width: 1, height: 1 });
  const [documentRatio, setDocumentRatio] = useState(1);
  const [remoteProfile, setRemoteProfile] = useState<{ name: string; avatar?: string } | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const sharedFileUrlRef = useRef('');
  const documentSessionRef = useRef('');
  const originalUploadRef = useRef<AbortController | null>(null);
  const sharedPageCacheRef = useRef<DocumentPageCache | null>(null);
  const documentRequestRef = useRef(0);
  const documentTargetPageRef = useRef(1);
  const remotePageImagesRef = useRef(new Map<string, HTMLImageElement>());
  const [documentView, setDocumentView] = useState(fitDocumentView);
  const documentViewRef = useRef(documentView);
  documentViewRef.current = documentView;
  const documentSizeRef = useRef(documentSize); documentSizeRef.current = documentSize;
  const remoteDocumentViewRef = useRef<SharedDocumentView | null>(null);
  const documentOverlayRef = useRef<SVGSVGElement>(null);
  const documentPanRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const documentPointersRef = useRef(new Map<number, { x: number; y: number }>());
  const documentPinchRef = useRef<{ distance: number; center: { x: number; y: number } } | null>(null);
  useEffect(() => { documentViewRef.current = fitDocumentView; setDocumentView(fitDocumentView); documentPointersRef.current.clear(); documentPanRef.current = null; documentPinchRef.current = null; }, [sharedDocument?.id, sharedDocument?.name, sharedDocument?.page]);
  useEffect(() => {
    if (role === 'student' && remoteDocumentViewRef.current) applyRemoteDocumentView(remoteDocumentViewRef.current);
  }, [sharedDocument?.id, sharedDocument?.name, sharedDocument?.page, documentSize, stageMode]);
  useEffect(() => {
    if (role !== 'teacher' || !sharedDocument) return;
    const frame = requestAnimationFrame(() => { const view = sharedDocumentView(); if (view) sendWhiteboard({ kind: 'document-view', view }); });
    return () => cancelAnimationFrame(frame);
  }, [documentView, documentSize, sharedDocument?.id, sharedDocument?.name, sharedDocument?.page]);
  useEffect(() => {
    const followed = remoteDocumentViewRef.current;
    if (role === 'student' && followed && sharedDocument && followed.documentId === (sharedDocument.id || sharedDocument.name) && followed.page === sharedDocument.page) return;
    const area = documentPageRef.current;
    if (area) setDocumentView(view => constrainDocumentView(view, documentSize, { width: area.clientWidth, height: area.clientHeight }));
  }, [documentSize]);
  const longPressRef = useRef<{ timer: number; x: number; y: number; point: WhiteboardPoint; item: WhiteboardItem } | null>(null);
  useEffect(() => {
    const page = documentPageRef.current;
    if (!page) return;
    const resize = () => { const width = Math.max(1, page.clientWidth - 28); const height = Math.max(1, page.clientHeight - 28); setDocumentSize({ width: Math.min(width, height * documentRatio), height: Math.min(height, width / documentRatio) }); };
    const observer = new ResizeObserver(resize); observer.observe(page); resize();
    return () => observer.disconnect();
  }, [stageMode, boardOpen, sharedDocument?.src, documentRatio]);
  useEffect(() => () => { if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current); if (longPressRef.current) clearTimeout(longPressRef.current.timer); if (desktopTextEditTimerRef.current !== null) clearTimeout(desktopTextEditTimerRef.current); }, []);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const notificationAudioRef = useRef<AudioContext | null>(null);
  const whiteboardSvgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = whiteboardSvgRef.current;
    if (!svg) return;
    const resize = () => { const rect = svg.getBoundingClientRect(); if (rect.width && rect.height) setWhiteboardAspect(rect.width / rect.height); };
    const observer = new ResizeObserver(resize); observer.observe(svg); resize();
    return () => observer.disconnect();
  }, [stageMode, boardOpen]);
  const whiteboardImageInputRef = useRef<HTMLInputElement>(null);
  const whiteboardFileInputRef = useRef<HTMLInputElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<VideoConnection | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const callGenerationRef = useRef(0);
  const joiningRef = useRef(false);
  const joinRetryTimerRef = useRef<number | null>(null);
  const recoverJoinRef = useRef(false);
  const startCallRef = useRef<() => void>(() => undefined);
  const cameraToggleBusyRef = useRef(false);
  const cameraRecoveryBlockedRef = useRef(false);
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
  // A cancelled touch or a stage switch can lose pointerup when SVG is removed.
  // Never let an old finger turn the student's next pen stroke into a pinch.
  useEffect(() => {
    whiteboardPointersRef.current.clear(); whiteboardPinchRef.current = null;
    panStartRef.current = null; whiteboardItemInteractionRef.current = null;
    activeStrokeRef.current = null; setActiveStroke(null);
  }, [stageMode]);
  const whiteboardDocumentRef = useRef<WhiteboardDocument | null>(null);
  const sharedDocumentSourceRef = useRef<{ name: string; pages: number; format: SharedDocument['format']; render: (page: number) => Promise<string>; destroy?: () => void | Promise<void> } | null>(null);
  const sharedDocumentRef = useRef<SharedDocument | null>(null);
  const stageModeRef = useRef<StageMode>('video');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const presenceRef = useRef(onPresenceChange);
  const localPeerIdRef = useRef<string | null>(null);
  const presencePeerIdRef = useRef<string | null>(null);
  const presenceJoinRetryRef = useRef<number | null>(null);
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
  const localName = displayName || (role === 'teacher' ? t("الأستاذ") : t("الطالب"));
  const remoteName = remoteProfile?.name || (role === 'teacher' ? t("الطالب") : t("الأستاذ"));
  const lessonFileUrl = (url: string) => url.startsWith('/api/') ? apiMediaUrl(url.replace(/^\/api\/(?:teachers|students)\//, `/api/${role === 'teacher' ? 'teachers' : 'students'}/`)) : url;

  const playCallSound = useCallback((kind: 'join' | 'leave' | 'mute' | 'unmute') => {
    try {
      const context = notificationAudioRef.current || new AudioContext();
      notificationAudioRef.current = context;
      void context.resume().then(() => {
        const tones = kind === 'join' ? [520, 780] : kind === 'leave' ? [540, 340] : kind === 'mute' ? [330] : [660];
        tones.forEach((frequency, index) => {
          const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + index * .11;
          oscillator.type = 'sine'; oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(kind === 'join' || kind === 'leave' ? .3 : .16, start + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + .22);
          oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start); oscillator.stop(start + .23);
        });
      }).catch(() => undefined);
    } catch { /* Playback may need a user gesture. */ }
  }, []);
  const remotePresentRef = useRef(false);
  const remoteAudioStateRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (hasRemoteStream !== remotePresentRef.current) playCallSound(hasRemoteStream ? 'join' : 'leave');
    remotePresentRef.current = hasRemoteStream;
  }, [hasRemoteStream, playCallSound]);
  useEffect(() => {
    if (!hasRemoteStream) { remoteAudioStateRef.current = null; return; }
    if (remoteAudioStateRef.current !== null && remoteAudioStateRef.current !== remoteAudioEnabled) playCallSound(remoteAudioEnabled ? 'unmute' : 'mute');
    remoteAudioStateRef.current = remoteAudioEnabled;
  }, [hasRemoteStream, remoteAudioEnabled, playCallSound]);

  useEffect(() => { presenceRef.current = onPresenceChange; }, [onPresenceChange]);
  useEffect(() => { if (localScreenRef.current) { localScreenRef.current.srcObject = localScreenStream; void localScreenRef.current.play().catch(() => undefined); } }, [localScreenStream, stageMode]);
  useEffect(() => { if (remoteScreenRef.current) { remoteScreenRef.current.srcObject = remoteScreenStream; void remoteScreenRef.current.play().catch(() => undefined); } }, [remoteScreenStream, stageMode]);
  useEffect(() => {
    if (!isConnected) return;
    try { sessionStorage.setItem(`lesson-media:${roomId}:${role}`, JSON.stringify({ audio: audioEnabled, video: videoEnabled })); } catch { /* In-memory media controls still work when storage is unavailable. */ }
  }, [roomId, role, isConnected, audioEnabled, videoEnabled]);
  useEffect(() => { sharedDocumentRef.current = sharedDocument; }, [sharedDocument]);
  useEffect(() => { stageModeRef.current = stageMode; }, [stageMode]);
  useEffect(() => { documentAnnotationsRef.current = documentAnnotations; }, [documentAnnotations]);

  const playMessageChime = useCallback(() => {
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = notificationAudioRef.current || new AudioContextClass();
      notificationAudioRef.current = context;
      void context.resume().then(() => {
        const gain = context.createGain();
        const oscillator = context.createOscillator();
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(740, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(980, context.currentTime + .12);
        gain.gain.setValueAtTime(.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(.16, context.currentTime + .018);
        gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .2);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(); oscillator.stop(context.currentTime + .21);
      }).catch(() => undefined);
    } catch { /* Audio can remain blocked until the next user gesture. */ }
  }, []);

  useEffect(() => {
    const unlockNotificationAudio = () => {
      try {
        const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return;
        const context = notificationAudioRef.current || new AudioContextClass();
        notificationAudioRef.current = context;
        void context.resume().catch(() => undefined);
      } catch { /* The next user gesture can try again. */ }
    };
    window.addEventListener('pointerdown', unlockNotificationAudio, { passive: true });
    window.addEventListener('keydown', unlockNotificationAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockNotificationAudio);
      window.removeEventListener('keydown', unlockNotificationAudio);
    };
  }, []);

  const resumeRemoteAudio = useCallback(async () => {
    const element = remoteAudioRef.current;
    const stream = remoteStreamRef.current;
    if (!element || !stream) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    try {
      element.volume = 1;
      element.muted = false;
      await element.play();
      setRemoteAudioBlocked(false);
    }
    catch { setRemoteAudioBlocked(true); }
  }, []);

  useEffect(() => {
    if (!hasRemoteStream) return;
    const recover = () => {
      void connectionRef.current?.repairAudio().catch(() => undefined);
      void resumeRemoteAudio();
    };
    const timer = window.setInterval(recover, 4000);
    document.addEventListener('pointerdown', recover, { passive: true });
    document.addEventListener('visibilitychange', recover);
    recover();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('pointerdown', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [hasRemoteStream, resumeRemoteAudio]);

  useEffect(() => {
    const previous = messageCountRef.current;
    if (messages.length > previous) {
      const incoming = messages.slice(previous).filter(message => !currentUserId || message.author_id !== currentUserId).length;
      if (incoming) {
        playMessageChime();
        if (sidePanel !== 'chat') setUnreadCallMessages(value => value + incoming);
      }
    }
    messageCountRef.current = messages.length;
  }, [messages, sidePanel, currentUserId, playMessageChime]);

  useEffect(() => {
    if (!isConnected) return;
    const restore = () => { if (document.visibilityState === 'visible') void resumeRemoteAudio(); };
    document.addEventListener('visibilitychange', restore);
    window.addEventListener('pointerdown', restore, { passive: true });
    return () => { document.removeEventListener('visibilitychange', restore); window.removeEventListener('pointerdown', restore); };
  }, [isConnected, resumeRemoteAudio]);

  useEffect(() => {
    if (sidePanel === 'chat') setUnreadCallMessages(0);
  }, [sidePanel]);

  useEffect(() => {
    if (!isConnected) return;
    let previousFrames = -1, previousTime = -1, stalled = 0, repairing = false;
    let lastFrameAt = performance.now(), frameCallback: number | undefined, alive = true;
    const watchedVideo = localVideoRef.current;
    const watchFrame = () => {
      if (!alive || !watchedVideo?.requestVideoFrameCallback) return;
      frameCallback = watchedVideo.requestVideoFrameCallback(() => { lastFrameAt = performance.now(); watchFrame(); });
    };
    watchFrame();
    const recover = async () => {
      if (document.visibilityState !== 'visible' || repairing || cameraRecoveryBlockedRef.current) return;
      const local = localVideoRef.current;
      const remote = remoteVideoRef.current;
      if (remote?.srcObject && remote.paused) void remote.play().catch(() => undefined);
      if (!videoEnabled || !local) { stalled = 0; return; }
      repairing = true;
      try {
        await connectionRef.current?.repairVideo();
        if (local.paused) await local.play().catch(() => undefined);
        const frames = local.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
        const frameStalled = typeof local.requestVideoFrameCallback === 'function' ? performance.now() - lastFrameAt > 4500 : frames > 0 && frames === previousFrames;
        const frozen = connectionQuality === 0 && frameStalled && local.currentTime === previousTime;
        stalled = frozen ? stalled + 1 : 0;
        previousFrames = frames;
        previousTime = local.currentTime;
        if (stalled === 2 && localStreamRef.current) { local.srcObject = new MediaStream(localStreamRef.current.getVideoTracks()); await local.play().catch(() => undefined); }
        if (stalled >= 4) { await connectionRef.current?.repairVideo(true); stalled = 0; }
      } catch (error) {
        const name = (error as DOMException)?.name;
        if (['NotFoundError', 'NotAllowedError', 'SecurityError'].includes(name)) {
          cameraRecoveryBlockedRef.current = true;
          const cameraLive = localStreamRef.current?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted);
          if (name !== 'NotFoundError' || !cameraLive) { setVideoEnabled(false); void connectionRef.current?.toggleVideo(false); }
        }
        setStatus(t('تعذر استعادة الكاميرا. اضغط زر الكاميرا لإعادة تشغيلها.'));
      }
      finally { repairing = false; }
    };
    const timer = window.setInterval(() => void recover(), 3000);
    const visible = () => { if (document.visibilityState === 'visible') { stalled = 0; lastFrameAt = performance.now(); void recover(); } };
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible); window.addEventListener('pageshow', visible);
    const devicesChanged = () => { cameraRecoveryBlockedRef.current = false; };
    navigator.mediaDevices?.addEventListener?.('devicechange', devicesChanged);
    return () => { alive = false; if (frameCallback !== undefined) watchedVideo?.cancelVideoFrameCallback?.(frameCallback); clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); window.removeEventListener('pageshow', visible); navigator.mediaDevices?.removeEventListener?.('devicechange', devicesChanged); };
  }, [isConnected, videoEnabled, isScreenSharing, connectionQuality]);

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

  useEffect(() => {
    const releaseMonitorOnExit = (event: PageTransitionEvent) => {
      if (event.persisted || !audioMonitorRef.current) return;
      const monitor = audioMonitorRef.current; audioMonitorRef.current = null;
      cancelAnimationFrame(monitor.frame); monitor.track.stop(); void monitor.context.close();
    };
    window.addEventListener('pagehide', releaseMonitorOnExit);
    return () => {
      window.removeEventListener('pagehide', releaseMonitorOnExit);
      callGenerationRef.current++;
      joiningRef.current = false;
      if (joinRetryTimerRef.current !== null) window.clearTimeout(joinRetryTimerRef.current);
      joinRetryTimerRef.current = null;
      recoverJoinRef.current = false;
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
      sharedPageCacheRef.current?.dispose();
      remotePageImagesRef.current.clear();
      originalUploadRef.current?.abort();
      documentRequestRef.current++;
      documentSessionRef.current = '';
      connectionRef.current?.close();
      if (notificationAudioRef.current) {
        void notificationAudioRef.current.close();
        notificationAudioRef.current = null;
      }
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
    if (!isConnected || !presenceRef.current) return;
    const heartbeat = () => { if (!localPeerIdRef.current) return; const update = presenceRef.current?.(true, localPeerIdRef.current, false); if (update) void update.catch(() => undefined); };
    heartbeat();
    const timer = window.setInterval(heartbeat, 15000);
    const refreshPresence = () => { if (document.visibilityState === 'visible') heartbeat(); };
    document.addEventListener('visibilitychange', refreshPresence);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshPresence); const update = presenceRef.current?.(false, presencePeerIdRef.current); if (update) void update.catch(() => undefined); };
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
      if (stageMode === 'document' && target?.closest('.document-page') || stageMode === 'whiteboard' && target?.closest('.whiteboard-panel') && (event.ctrlKey || event.metaKey)) event.preventDefault();
    };
    const blockBrowserZoomKeys = (event: KeyboardEvent) => {
      if (!['whiteboard', 'document'].includes(stageMode) || (!event.ctrlKey && !event.metaKey)) return;
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
    const timer = window.setTimeout(() => startCallRef.current(), 0);
    // Failed startup also needs recovery listeners; isConnected is still false.
    const recover = () => {
      if (document.visibilityState === 'visible' && recoverJoinRef.current && !joiningRef.current) startCallRef.current();
    };
    window.addEventListener('online', recover);
    window.addEventListener('pageshow', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', recover);
      window.removeEventListener('pageshow', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, []);

  const startCall = async (attempt = 0) => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    recoverJoinRef.current = false;
    if (joinRetryTimerRef.current !== null) window.clearTimeout(joinRetryTimerRef.current);
    joinRetryTimerRef.current = null;
    cameraRecoveryBlockedRef.current = false;
    const generation = ++callGenerationRef.current;
    setIsJoining(true);
    setStatus(t("جار الانضمام للغرفة"));
    try {
      await authorize();
      if (generation !== callGenerationRef.current) return;
      connectionRef.current?.close();
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      setIsScreenSharing(false);
      setShowScreenShareNotice(false);
      setRemoteVideoSource('camera');
      setRemoteVideoEnabled(false);
      setRemoteAudioEnabled(true);
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
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
          for (const track of stream.getAudioTracks()) track.onunmute = () => void resumeRemoteAudio();
          void resumeRemoteAudio();
          setHasRemoteStream(true);
          setReportedRemotePresent(true);
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
        onRemoteAudioEnabled: setRemoteAudioEnabled,
        onRemoteProfile: setRemoteProfile,
        onLocalStreamChange: stream => {
          localStreamRef.current = stream;
          if (localVideoRef.current) { localVideoRef.current.srcObject = new MediaStream(stream.getVideoTracks()); void localVideoRef.current.play().catch(() => undefined); }
        },
        onWhiteboardMessage: handleWhiteboardMessage,
        onRemoteTyping: (typing) => {
          if (remoteTypingTimerRef.current !== null) window.clearTimeout(remoteTypingTimerRef.current);
          setRemoteTyping(typing);
          if (typing) remoteTypingTimerRef.current = window.setTimeout(() => setRemoteTyping(false), 1800);
        },
        onRemoteSpeaking: setRemoteSpeaking,
        onDataOpen: () => { if (role === 'student' && youtubeRef.current) sendWhiteboard({ kind: 'youtube', session: youtubeRef.current }); role === 'student' ? sendWhiteboard({ kind: 'sync-request' }) : sendWhiteboard({ kind: 'sync', strokes: whiteboardStrokesRef.current, items: whiteboardItemsRef.current, mode: stageModeRef.current, boardOpen: boardOpenRef.current, document: sharedDocumentRef.current, annotations: documentAnnotationsRef.current }); },
        onLocalPeerId: (peerId) => {
          if (presenceJoinRetryRef.current !== null) window.clearTimeout(presenceJoinRetryRef.current);
          presenceJoinRetryRef.current = null;
          localPeerIdRef.current = peerId;
          if (peerId) presencePeerIdRef.current = peerId;
          const publish = async (attempt = 0) => {
            try { await presenceRef.current?.(Boolean(peerId), peerId || presencePeerIdRef.current, Boolean(peerId)); }
            catch (error) {
              const status = (error as { status?: number })?.status;
              if (!peerId || localPeerIdRef.current !== peerId || attempt >= 2 || (status && status >= 400 && status < 500 && status !== 429)) return;
              presenceJoinRetryRef.current = window.setTimeout(() => { if (localPeerIdRef.current === peerId) void publish(attempt + 1); }, 1500);
            }
          };
          void publish();
        },
        getRemotePeerId,
        initialRemotePeerId,
        onRemotePresence: setReportedRemotePresent,
        onLocalVideoSource: (source) => {
          setIsScreenSharing(source === 'screen');
          if (source === 'screen') {
            setStageMode('video');
            setFocusedParticipant(null);
          }
        },
        onLocalScreenStream: setLocalScreenStream,
        onRemoteScreenStream: stream => { setRemoteScreenStream(stream); if (stream) setStageMode('video'); },
        onPeerLeft: () => {
          if (remoteTypingTimerRef.current !== null) window.clearTimeout(remoteTypingTimerRef.current);
          setRemoteTyping(false);
          remoteStreamRef.current = null;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
          setRemoteSpeaking(false);
          setRemoteAudioBlocked(false);
          setRemoteVideoSource('camera');
          setRemoteVideoEnabled(false);
          setRemoteAudioEnabled(true);
          setRemoteScreenStream(null);
          setHasRemoteStream(false);
          setReportedRemotePresent(false);
          setFocusedParticipant(null);
        },
        onStatus: setStatus,
        onConnectionQuality: setConnectionQuality,
      });
      connectionRef.current = connection;
      connection.sendProfile({ name: localName, avatar: avatarUrl });
      const localStream = await connection.start({ video: videoEnabled });
      connection.toggleAudio(audioEnabled);
      if (videoEnabled) {
        try { await connection.toggleVideo(true); }
        catch { setVideoEnabled(false); setStatus(t('تعذر استعادة الكاميرا. اضغط زر الكاميرا لإعادة تشغيلها.')); }
      }
      if (generation !== callGenerationRef.current) { connection.close(); return; }
      localStreamRef.current = localStream;
      startAudioMonitor(localStream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
        void localVideoRef.current.play().catch(() => undefined);
      }
      setIsConnected(true);
    } catch (error) {
      if (generation !== callGenerationRef.current) return;
      connectionRef.current?.close();
      connectionRef.current = null;
      const failure = error as { status?: number; name?: string; cause?: { name?: string } };
      const name = failure.cause?.name || failure.name;
      // Denied devices/authorization require an explicit user action, never a prompt loop.
      const retryable = !['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotSupportedError', 'OverconstrainedError'].includes(name || '')
        && (!failure.status || failure.status === 408 || failure.status === 429 || failure.status >= 500);
      recoverJoinRef.current = retryable;
      if (retryable && attempt < 3) {
        joinRetryTimerRef.current = window.setTimeout(() => {
          joinRetryTimerRef.current = null;
          if (generation === callGenerationRef.current) void startCall(attempt + 1);
        }, [750, 1500, 3000][attempt]);
      }
      setStatus(error instanceof Error ? error.message : t("تعذر بدء المكالمة"));
      setIsConnected(false);
    } finally {
      if (generation === callGenerationRef.current) {
        joiningRef.current = false;
        setIsJoining(joinRetryTimerRef.current !== null);
      }
    }
  };
  startCallRef.current = () => { void startCall(); };

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
          connectionRef.current?.sendSpeaking(stableSpeaking && sourceTrack.enabled);
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
    playCallSound('leave');
    if (audioMonitorRef.current) { cancelAnimationFrame(audioMonitorRef.current.frame); audioMonitorRef.current.track.stop(); void audioMonitorRef.current.context.close(); audioMonitorRef.current = null; }
    speakingRef.current = false; setLocalSpeaking(false); setRemoteSpeaking(false); setMutedSpeechWarning(false);
    callGenerationRef.current++;
    joiningRef.current = false;
    if (joinRetryTimerRef.current !== null) window.clearTimeout(joinRetryTimerRef.current);
    joinRetryTimerRef.current = null;
    recoverJoinRef.current = false;
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
    setLocalScreenStream(null); setRemoteScreenStream(null);
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
    const presenceUpdate = onPresenceChange?.(false, presencePeerIdRef.current);
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
    playCallSound(nextValue ? 'unmute' : 'mute');
    if (nextValue) { setLocalSpeaking(speakingRef.current); connectionRef.current?.sendSpeaking(speakingRef.current); }
    if (!nextValue) { setLocalSpeaking(false); connectionRef.current?.sendSpeaking(false); }
    if (nextValue) setMutedSpeechWarning(false);
    void audioMonitorRef.current?.context.resume().catch(() => undefined);
  };

  const handleVideoToggle = async () => {
    cameraRecoveryBlockedRef.current = false;
    const connection = connectionRef.current;
    if (!connection || cameraToggleBusyRef.current) return;
    cameraToggleBusyRef.current = true;
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
    } finally { cameraToggleBusyRef.current = false; }
  };

  const handleCameraSwitch = async () => {
    const connection = connectionRef.current;
    if (!connection || cameraToggleBusyRef.current) return;
    cameraToggleBusyRef.current = true; setCameraSwitching(true);
    try { const result = await connection.switchCamera(); setCameraFacing(result.facing); setVideoEnabled(Boolean(result.stream?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled))); }
    catch { setVideoEnabled(Boolean(localStreamRef.current?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled))); setStatus(t('تعذر تبديل الكاميرا. حاول مجدداً.')); }
    finally { cameraToggleBusyRef.current = false; setCameraSwitching(false); }
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
        await connectionRef.current.stopScreenShare();
        setIsScreenSharing(false);
        return;
      }
      await connectionRef.current.startScreenShare();
      setIsScreenSharing(true);
      setShowScreenShareNotice(false);
      setStageMode('video');
      setFocusedParticipant(null);
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
      element.srcObject = new MediaStream(localStreamRef.current.getVideoTracks());
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
    return kind === 'document-view' || kind === 'youtube' || kind === 'sync-request' || kind === 'pointer' || kind === 'clear' || kind === 'stroke-start' || kind === 'stroke-points' || kind === 'stroke' || kind === 'sync' || kind === 'mode' || kind === 'board-session' || kind === 'document' || kind === 'document-preload' || kind === 'document-annotations' || kind === 'erase' || kind === 'item-upsert' || kind === 'item-delete';
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
    if (message.kind === 'document-view') { applyRemoteDocumentView(message.view); return; }
    if (message.kind === 'youtube') { if (message.session === null && role === 'teacher') return; if (message.session === null || validYoutubeSession(message.session)) updateYoutube(message.session); return; }
    if (message.kind === 'sync-request') {
      if (role === 'teacher') sendWhiteboard({ kind: 'sync', strokes: whiteboardStrokesRef.current, items: whiteboardItemsRef.current, mode: stageModeRef.current, boardOpen: boardOpenRef.current, document: sharedDocumentRef.current, annotations: documentAnnotationsRef.current });
      return;
    }
    if (message.kind === 'pointer') {
      const point = message.pointer;
      if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !['whiteboard', 'document'].includes(point.space))) return;
      setRemotePointer(point);
      if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current);
      pointerTimerRef.current = window.setTimeout(() => setRemotePointer(null), 2800);
      return;
    }
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
    if (message.kind === 'board-session') {
      updateBoardOpen(message.open);
      if (!message.open && stageModeRef.current === 'whiteboard') setStageMode(sharedDocumentRef.current ? 'document' : 'video');
      return;
    }
    if (message.kind === 'mode') { if (message.mode === 'whiteboard') updateBoardOpen(true); return setStageMode(message.mode); }
    if (message.kind === 'document-preload') {
      if (message.id !== sharedDocumentRef.current?.id || typeof message.src !== 'string') return;
      const key = `${message.id}:${message.page}`;
      if (remotePageImagesRef.current.has(key)) return;
      const image = new Image(); image.src = lessonFileUrl(message.src);
      remotePageImagesRef.current.set(key, image);
      while (remotePageImagesRef.current.size > 8) remotePageImagesRef.current.delete(remotePageImagesRef.current.keys().next().value!);
      void image.decode?.().catch(() => undefined);
      return;
    }
    if (message.kind === 'document') {
      const current = sharedDocumentRef.current;
      const isNew = !current || (message.document?.id ? message.document.id !== current.id : message.document?.name !== current.name);
      if (isNew || !message.document) remotePageImagesRef.current.clear();
      sharedDocumentRef.current = message.document;
      setSharedDocument(message.document);
      if (message.document && isNew) { setStageMode('document'); setFocusedParticipant(null); }
      else if (!message.document && stageModeRef.current === 'document') setStageMode(boardOpenRef.current ? 'whiteboard' : 'video');
      return;
    }
    if (message.kind === 'document-annotations') {
      setDocumentAnnotations(message.annotations);
      documentAnnotationsRef.current = message.annotations;
      return;
    }
    if (message.kind === 'sync') {
      if ((message.youtube === null && role !== 'teacher') || validYoutubeSession(message.youtube)) updateYoutube(message.youtube);
      if (message.boardOpen !== undefined) updateBoardOpen(message.boardOpen);
      else if (message.mode === 'whiteboard') updateBoardOpen(true);
      if (message.mode) { setStageMode(message.mode); setFocusedParticipant(null); }
      if (message.document !== undefined) { sharedDocumentRef.current = message.document; setSharedDocument(message.document); }
      if (message.documentView) applyRemoteDocumentView(message.documentView);
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
    connectionRef.current?.sendWhiteboard(message.kind === 'sync' ? { ...message, ...(youtubeRef.current ? { youtube: youtubeRef.current } : {}), ...(role === 'teacher' ? { documentView: sharedDocumentView() || undefined } : {}) } : message);
  };
  function sharedDocumentView(): SharedDocumentView | null {
    const doc = sharedDocumentRef.current, size = documentSizeRef.current, view = documentViewRef.current;
    return doc ? { documentId: doc.id || doc.name, page: doc.page, zoom: view.zoom, x: view.x / Math.max(1, size.width), y: view.y / Math.max(1, size.height) } : null;
  }
  function applyRemoteDocumentView(view: SharedDocumentView) {
    if (role !== 'student' || !view || typeof view.documentId !== 'string' || !Number.isInteger(view.page) || !Number.isFinite(view.zoom) || view.zoom < 1 || view.zoom > 6 || !Number.isFinite(view.x) || !Number.isFinite(view.y) || Math.abs(view.x) > 6 || Math.abs(view.y) > 6) return;
    remoteDocumentViewRef.current = view;
    const doc = sharedDocumentRef.current, size = documentSizeRef.current;
    if (!doc || (doc.id || doc.name) !== view.documentId || doc.page !== view.page) return;
    const next = { zoom: view.zoom, x: view.x * size.width, y: view.y * size.height };
    documentViewRef.current = next; setDocumentView(next);
  }

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
    if ((event.target as Element).closest('textarea,input,[contenteditable=true]')) return;
    if (whiteboardTool !== 'select') return;
    if (event.pointerType === 'touch' && whiteboardPointersRef.current.size > 0 && !whiteboardPointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    whiteboardPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    const svg = whiteboardSvgRef.current;
    if (!svg) return;
    const syntheticEvent = { currentTarget: svg, clientX: event.clientX, clientY: event.clientY } as PointerEvent<SVGSVGElement>;
    whiteboardItemInteractionRef.current = { id: item.id, mode, start: whiteboardPoint(syntheticEvent), item: { ...item }, moved: false };
    setSelectedWhiteboardItem(item.id);
    if (mode === 'move') setEditingWhiteboardText(null);
    setWhiteboardTool('select');
  };

  const beginWhiteboardTextEdit = (item: WhiteboardItem) => {
    if (item.type !== 'text') return;
    whiteboardPointersRef.current.clear(); whiteboardPinchRef.current = null;
    whiteboardItemInteractionRef.current = null; pendingTextPointRef.current = null;
    setSelectedWhiteboardItem(item.id);
    ignoreEditorOpeningClickRef.current = mobileWhiteboard;
    setMobileTextDraft(item.text);
    setEditingWhiteboardText(item.id);
  };

  const addWhiteboardText = (point: WhiteboardPoint) => {
    const screenScale = (whiteboardSvgRef.current?.getBoundingClientRect().width || 1000) / (1000 / whiteboardViewport.zoom);
    const item: WhiteboardTextItem = {
      id: createWhiteboardId('text'),
      type: 'text',
      x: point.x,
      y: point.y,
      width: (mobileWhiteboard ? 620 : 300) / whiteboardViewport.zoom,
      height: (mobileWhiteboard ? 200 : 100) / whiteboardViewport.zoom,
      text: '',
      color: '#18171c',
      fontSize: mobileWhiteboard ? 24 / screenScale : 34 / whiteboardViewport.zoom,
      fontFamily: 'Tajawal, sans-serif',
      fontWeight: 700,
      fontStyle: 'normal',
      textAlign: 'start',
      background: 'transparent',
      opacity: 1,
    };
    if (mobileWhiteboard) {
      item.x = Math.max(whiteboardViewport.x, Math.min(point.x, whiteboardViewport.x + 1000 / whiteboardViewport.zoom - item.width));
      item.y = Math.max(whiteboardViewport.y, Math.min(point.y, whiteboardViewport.y + 1000 / whiteboardViewport.zoom / getLiveWhiteboardAspect() - item.height));
    }
    upsertWhiteboardItem(item, true);
    setSelectedWhiteboardItem(item.id);
    setWhiteboardTool('select');
    if (mobileWhiteboard) beginWhiteboardTextEdit(item);
    else { setEditingWhiteboardText(null); if (desktopTextEditTimerRef.current !== null) clearTimeout(desktopTextEditTimerRef.current); desktopTextEditTimerRef.current = window.setTimeout(() => { desktopTextEditTimerRef.current = null; beginWhiteboardTextEdit(item); }, 0); }
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
    const cache = sharedPageCacheRef.current;
    if (!source || !cache) return;
    const selectedPage = Math.min(source.pages, Math.max(1, page));
    documentTargetPageRef.current = selectedPage;
    const requestId = ++documentRequestRef.current;
    setWhiteboardDocumentBusy(true);
    try {
      const src = await cache.local(selectedPage);
      if (source !== sharedDocumentSourceRef.current || requestId !== documentRequestRef.current) return;
      const document = { id: documentSessionRef.current, name: source.name, page: selectedPage, pages: source.pages, src, fileUrl: sharedFileUrlRef.current, format: source.format } satisfies SharedDocument;
      sharedDocumentRef.current = document;
      setSharedDocument(document);
      setStageMode('document');
      setFocusedParticipant(null);
      // The teacher sees the local preview immediately. The peer uses a warmed,
      // authenticated URL without waiting for the original file upload.
      const share = cache.share(selectedPage);
      cache.warm(selectedPage);
      void share.then(sharedSrc => {
        if (source !== sharedDocumentSourceRef.current || requestId !== documentRequestRef.current) return;
        const next = { ...document, src: sharedSrc, fileUrl: sharedFileUrlRef.current };
        sharedDocumentRef.current = next; setSharedDocument(next);
        sendWhiteboard({ kind: 'document', document: next });
      }).catch(error => {
        if (source !== sharedDocumentSourceRef.current || requestId !== documentRequestRef.current) return;
        sendWhiteboard({ kind: 'document', document });
        setStatus(error instanceof Error ? error.message : t('تعذر رفع معاينة الصفحة.'));
      });
    } finally {
      if (requestId === documentRequestRef.current) setWhiteboardDocumentBusy(false);
    }
  };

  const loadSharedDocument = async (file: File) => {
    if (!file.size) throw new Error(t('اختر ملفاً غير فارغ.'));
    if (file.size > 100 * 1024 * 1024) throw new Error(t('الحد الأقصى للملف 100 ميغابايت.'));
    const extension = file.name.toLowerCase().split('.').pop() || '';
    const previous = sharedDocumentSourceRef.current;
    sharedPageCacheRef.current?.dispose(); documentRequestRef.current++;
    originalUploadRef.current?.abort();
    const upload = new AbortController(); originalUploadRef.current = upload;
    const session = crypto.randomUUID(); documentSessionRef.current = session;
    sharedFileUrlRef.current = lessonId ? '' : URL.createObjectURL(file);
    // The preview and the original travel independently: hundreds of pages do
    // not make the first page wait for the full original to reach the server.
    if (lessonId) void requestFile<{ url: string }>(`teachers/bookings/${lessonId}/files`, file, {}, upload.signal).then(result => {
      if (upload.signal.aborted || documentSessionRef.current !== session) return;
      sharedFileUrlRef.current = result.url;
      const current = sharedDocumentRef.current;
      if (current?.id === session) {
        const next = { ...current, fileUrl: result.url }; sharedDocumentRef.current = next; setSharedDocument(next); sendWhiteboard({ kind: 'document', document: next });
      }
    }).catch(() => { if (!upload.signal.aborted && documentSessionRef.current === session) setStatus(t('تعذر رفع نسخة التنزيل. معاينة الملف ما زالت متاحة.')); });
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
          const resolution = window.matchMedia('(max-width: 760px)').matches ? 1200 : 1600;
          const viewport = page.getViewport({ scale: Math.min(2, resolution / base.width, resolution / base.height) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error(t('تعذر تجهيز صفحة الملف.'));
          await page.render({ canvasContext: context, viewport }).promise;
          const src = canvas.toDataURL('image/webp', .82);
          page.cleanup(); canvas.width = 1; canvas.height = 1;
          return src;
        },
        destroy: () => pdf.destroy(),
      };
    } else if (['ppt', 'pptx'].includes(extension)) {
      const worker = new Worker(new URL('./presentationWorker.ts', import.meta.url), { type: 'module' });
      let sequence = 0;
      const work = (data: { file?: File; page?: number }) => new Promise<{ pages: number; src: string }>((resolve, reject) => {
        const id = ++sequence;
        const timer = window.setTimeout(() => { worker.terminate(); reject(new Error(t('تعذر تجهيز الملف. حاول ملفاً أصغر أو نسخة PDF.'))); }, 90000);
        const received = (event: MessageEvent) => { if (event.data.id !== id) return; clearTimeout(timer); worker.removeEventListener('message', received); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
        worker.addEventListener('message', received); worker.onerror = () => { clearTimeout(timer); reject(new Error(t('تعذر تجهيز الملف. حاول ملفاً أصغر أو نسخة PDF.'))); };
        worker.postMessage({ id, ...data });
      });
      const presentation = await work({ file }).catch(error => { worker.terminate(); throw error; });
      source = {
        name: file.name,
        pages: presentation.pages,
        format: 'presentation',
        render: async (pageNumber) => (await work({ page: pageNumber })).src,
        destroy: () => worker.terminate(),
      };
    } else if (extension === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const chunks = splitDocumentText(result.value);
      source = { name: file.name, pages: chunks.length, format: 'text', render: async page => textDocumentPage(chunks[page - 1]) };
    } else if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      let src: string;
      try { src = await rasterizeSlide(url); } finally { URL.revokeObjectURL(url); }
      source = { name: file.name, pages: 1, format: 'image', render: async () => src };
    } else if (file.type.startsWith('text/') || ['txt', 'md', 'csv', 'json'].includes(extension)) {
      const raw = await file.text();
      const chunks = splitDocumentText(raw);
      source = { name: file.name, pages: chunks.length, format: 'text', render: async page => textDocumentPage(chunks[page - 1]) };
    } else {
      source = { name: file.name, pages: 1, format: 'file', render: async () => textDocumentPage(t('الملف متاح للتنزيل من الزر أعلاه'), file.name) };
    }
    if (!source?.pages) throw new Error(t('الملف لا يحتوي على صفحات قابلة للعرض.'));
    sharedDocumentSourceRef.current = source;
    const currentSource = source;
    sharedPageCacheRef.current = new DocumentPageCache({
      count: source.pages,
      render: async page => { const src = await currentSource.render(page); return src.startsWith('data:image/svg+xml') ? rasterizeSlide(src) : src; },
      publish: async (src, page) => {
        if (!lessonId || !src.startsWith('data:')) return src;
        const blob = await (await fetch(src)).blob();
        const result = await requestFile<{ url: string }>(`teachers/bookings/${lessonId}/files`, new File([blob], `page-${page}.webp`, { type: blob.type }), {}, upload.signal);
        return `${result.url}?preview=1`;
      },
      onReady: (src, page) => { if (documentSessionRef.current === session) sendWhiteboard({ kind: 'document-preload', id: session, page, src }); },
    });
    await previous?.destroy?.();
    setDocumentAnnotations([]); documentAnnotationsRef.current = [];
    sendWhiteboard({ kind: 'document-annotations', annotations: [] });
    await publishSharedDocumentPage(1);
  };

  const changeSharedDocumentPage = (direction: -1 | 1) => {
    if (!sharedDocument) return;
    void publishSharedDocumentPage(documentTargetPageRef.current + direction).catch(error => setStatus(error instanceof Error ? error.message : t('تعذر فتح صفحة الملف.')));
  };

  const closeSharedDocument = () => {
    documentRequestRef.current++;
    originalUploadRef.current?.abort(); documentSessionRef.current = '';
    sharedDocumentRef.current = null;
    setSharedDocument(null);
    if (stageModeRef.current === 'document') setStageMode(boardOpenRef.current ? 'whiteboard' : 'video');
    sendWhiteboard({ kind: 'document', document: null });
    void sharedDocumentSourceRef.current?.destroy?.(); sharedDocumentSourceRef.current = null;
    sharedPageCacheRef.current?.dispose(); sharedPageCacheRef.current = null;
    remotePageImagesRef.current.clear();
    if (sharedFileUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(sharedFileUrlRef.current);
  };

  const handleWhiteboardFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFocusedParticipant(null); setSidePanel(null); setShowMore(false);
    setDocumentLoading(true);
    void loadSharedDocument(file).catch((error) => setStatus(error instanceof Error ? error.message : t('تعذر فتح الملف.'))).finally(() => { setDocumentLoading(false); connectionRef.current?.resumeAfterBackground(); });
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

  const downloadWhiteboard = async () => {
    const svg = whiteboardSvgRef.current;
    if (!svg || boardExporting) return;
    const { x, y, width, height } = svg.viewBox.baseVal;
    setBoardExporting(true);
    try {
      const blob = await whiteboardPng({ view: { x, y, width, height }, items: whiteboardItemsRef.current.map(item => ({ ...item })), strokes: [...whiteboardStrokesRef.current, ...(activeStroke ? [activeStroke] : [])] });
      const file = new File([blob], `emtidad-board-${new Date().toISOString().slice(0, 10)}.png`, { type: 'image/png' });
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      const mobileShare = navigator.maxTouchPoints > 0 && !!navigator.canShare?.({ files: [file] });
      if (ios || mobileShare) setBoardImage(file); else downloadBoardImage(file);
    } catch { setStatus(t('تعذر حفظ صورة البورد. حاول مجدداً.')); }
    finally { setBoardExporting(false); }
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

  const publishPointer = (pointer: SharedPointer | null, force = false) => {
    setLocalPointer(pointer);
    if (force || performance.now() - pointerSentRef.current > 40) { pointerSentRef.current = performance.now(); sendWhiteboard({ kind: 'pointer', pointer }); }
  };
  useEffect(() => {
    if (!localPointer) return;
    const timer = window.setInterval(() => sendWhiteboard({ kind: 'pointer', pointer: localPointer }), 1000);
    return () => window.clearInterval(timer);
  }, [localPointer]);
  useEffect(() => { publishPointer(null, true); setRemotePointer(null); }, [stageMode, sharedDocument?.page]);
  const renderPointer = (pointer: SharedPointer | null, space: SharedPointer['space'], remote = false) => pointer?.space === space && (space !== 'document' || pointer.page === sharedDocument?.page) ? space === 'document' ? <ellipse className={`shared-pointer ${remote ? 'remote' : 'local'}`} cx={pointer.x} cy={pointer.y} rx={8000 / Math.max(1, documentSize.width * documentView.zoom)} ry={11200 / Math.max(1, documentSize.height * documentView.zoom)} fill="#ef3333" fillOpacity=".8" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" /> : <circle className={`shared-pointer ${remote ? 'remote' : 'local'}`} cx={pointer.x} cy={pointer.y} r={10 / whiteboardViewport.zoom} fill="#ef3333" fillOpacity=".8" stroke="#fff" strokeWidth={2 / whiteboardViewport.zoom} pointerEvents="none" /> : null;
  const startTextLongPress = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'touch' || !['select', 'text'].includes(whiteboardTool) || (event.target as Element).closest('textarea,input,[contenteditable=true],.whiteboard-resize-handle')) return;
    if (whiteboardPointersRef.current.size > 0) return;
    const point = whiteboardPoint(event);
    const item = [...whiteboardItemsRef.current].reverse().find(item => point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height);
    if (!item || item.type !== 'text') return;
    event.preventDefault(); event.stopPropagation();
    whiteboardPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      setEditingWhiteboardText(null); setSelectedWhiteboardItem(item.id); setWhiteboardTool('select');
      whiteboardItemInteractionRef.current = { id: item.id, mode: 'move', start: point, item: { ...item }, moved: true };
    }, 450);
    longPressRef.current = { timer, x: event.clientX, y: event.clientY, point, item };
  };
  const startWhiteboardStroke = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'touch') { whiteboardPointersRef.current.clear(); whiteboardPinchRef.current = null; }
    whiteboardPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (whiteboardPointersRef.current.size >= 2) {
      pendingTextPointRef.current = null;
      if (longPressRef.current) { clearTimeout(longPressRef.current.timer); longPressRef.current = null; }
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
      if (event.pointerType === 'touch') { event.preventDefault(); pendingTextPointRef.current = whiteboardPoint(event); }
      else addWhiteboardText(whiteboardPoint(event));
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
    publishPointer({ ...whiteboardPoint(event), space: 'whiteboard' });
    if (longPressRef.current) {
      const press = longPressRef.current;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 9) return;
      clearTimeout(press.timer); longPressRef.current = null;
      setSelectedWhiteboardItem(press.item.id); setWhiteboardTool('select');
      whiteboardItemInteractionRef.current = { id: press.item.id, mode: 'move', start: press.point, item: { ...press.item }, moved: true };
    }
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
    const cancelled = event?.type === 'pointercancel';
    const wasPinching = whiteboardPinchRef.current !== null;
    if (event) { whiteboardPointersRef.current.delete(event.pointerId); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
    if (whiteboardPointersRef.current.size < 2) whiteboardPinchRef.current = null;
    if (longPressRef.current) { const press = longPressRef.current; clearTimeout(press.timer); longPressRef.current = null; if (!cancelled && !wasPinching) beginWhiteboardTextEdit(press.item); return; }
    if (pendingTextPointRef.current) { const point = pendingTextPointRef.current; pendingTextPointRef.current = null; if (!cancelled && !wasPinching) addWhiteboardText(point); return; }
    if (wasPinching) return;
    const itemInteraction = whiteboardItemInteractionRef.current;
    if (itemInteraction) {
      whiteboardItemInteractionRef.current = null;
      const item = whiteboardItemsRef.current.find((candidate) => candidate.id === itemInteraction.id);
      if (item) {
        sendWhiteboard({ kind: 'item-upsert', item });
        if (!cancelled && item.type === 'text' && itemInteraction.mode === 'move' && !itemInteraction.moved) beginWhiteboardTextEdit(item);
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
    if (finishedStroke.points.length > 0 && !cancelled) {
      setSyncedWhiteboardStrokes((current) => [...current, finishedStroke]);
      sendWhiteboard({ kind: 'stroke', stroke: finishedStroke });
    } else sendWhiteboard({ kind: 'erase', ids: [finishedStroke.id] });
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
      <g key={item.id} data-whiteboard-item-id={item.id} {...commonProps} onDoubleClick={() => beginWhiteboardTextEdit(item)}>
        {item.type === 'image' ? (
          <foreignObject x={item.x} y={item.y} width={item.width} height={item.height} opacity={item.opacity ?? 1}>
            <img className="whiteboard-board-image" draggable={false} src={item.src} alt="" style={{ objectFit: item.fit || 'contain', borderRadius: item.borderRadius || 0 }} />
          </foreignObject>
        ) : (
          <foreignObject x={item.x} y={item.y} width={item.width} height={item.height}>
            {editingWhiteboardText === item.id && !mobileWhiteboard ? <textarea
              autoFocus
              className="whiteboard-text-editor"
              dir="auto"
              value={item.text}
              style={{ color: item.color, fontSize: item.fontSize, fontFamily: item.fontFamily, fontWeight: item.fontWeight, fontStyle: item.fontStyle, textAlign: item.textAlign, background: item.background, opacity: item.opacity ?? 1 }}
              placeholder={t('اكتب هنا')}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => upsertWhiteboardItem({ ...item, text: event.target.value }, true)}
              onBlur={() => { const current = whiteboardItemsRef.current.find(row => row.id === item.id); if (current?.type === 'text' && !current.text.trim()) deleteWhiteboardItem(item.id); else setEditingWhiteboardText(null); }}
            /> : <div className="whiteboard-text-content" dir="auto" style={{ color: item.color, fontSize: item.fontSize, fontFamily: item.fontFamily, fontWeight: item.fontWeight, fontStyle: item.fontStyle, textAlign: item.textAlign, background: item.background, opacity: item.opacity ?? 1 }}>{item.text || t('اكتب هنا')}</div>}
          </foreignObject>
        )}
        {!(editingWhiteboardText === item.id && !mobileWhiteboard) && <rect className="whiteboard-item-hitbox" x={item.x} y={item.y} width={item.width} height={item.height} fill="transparent" />}
        {selected && <>
          <rect className="whiteboard-selection-box" x={item.x} y={item.y} width={item.width} height={item.height} />
          <circle className="whiteboard-resize-handle" cx={item.x + item.width} cy={item.y + item.height} r={mobileWhiteboard ? 18 * viewWidth / (whiteboardSvgRef.current?.clientWidth || 370) : 10 / whiteboardViewport.zoom} onPointerDown={(event) => startWhiteboardItemInteraction(event, item, 'resize')} />
        </>}
      </g>
    );
  };

  const renderWhiteboardTools = () => (
      <div className="whiteboard-tools" aria-label={t('أدوات اللوح')}>
        <span className="whiteboard-tool-heading">{t('أدوات اللوح')}</span>
        <button data-whiteboard-tool="select" className={whiteboardTool === 'select' ? 'selected tool-mode' : 'tool-mode'} type="button" onPointerDown={event => { if (event.pointerType === 'touch') setWhiteboardTool('select'); }} onClick={() => setWhiteboardTool('select')} aria-label={t('تحديد وتحريك العناصر')} title={t('تحديد وتحريك العناصر')}><MousePointer2 size={17} /></button>
        <button data-whiteboard-tool="draw" className={whiteboardTool === 'draw' ? 'selected tool-mode' : 'tool-mode'} type="button" onPointerDown={event => { if (event.pointerType === 'touch') setWhiteboardTool('draw'); }} onClick={() => setWhiteboardTool('draw')} aria-label={t('الرسم بالقلم')} title={t('الرسم بالقلم')}><Pencil size={17} /></button>
        <button data-whiteboard-tool="pan" className={whiteboardTool === 'pan' ? 'selected tool-mode' : 'tool-mode'} type="button" onPointerDown={event => { if (event.pointerType === 'touch') setWhiteboardTool('pan'); }} onClick={() => setWhiteboardTool('pan')} aria-label={t("تحريك اللوح")} title={t("تحريك اللوح")}><Hand size={17} /></button>
        <button data-whiteboard-tool="text" className={whiteboardTool === 'text' ? 'selected tool-mode' : 'tool-mode'} type="button" onPointerDown={event => { if (event.pointerType === 'touch') setWhiteboardTool('text'); }} onClick={() => setWhiteboardTool('text')} aria-label={t('إضافة نص')} title={t('إضافة نص')}><TypeIcon size={17} /></button>
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
        <button className="tool-mode" type="button" disabled={boardExporting} onClick={() => void downloadWhiteboard()} title={t('تنزيل اللوح')} aria-label={t('تنزيل اللوح')}>{boardExporting ? <RefreshCw size={17} /> : <Download size={17} />}</button>
        {role === 'teacher' && <button className="whiteboard-clear" type="button" onClick={clearWhiteboard} title={t("مسح اللوح")}><Trash2 size={17} /></button>}
      </div>
  );

  const renderWhiteboard = () => (
    <div className="whiteboard-panel" aria-label={t('اللوح المشترك. يمكنك لصق صورة مباشرة باستخدام Ctrl+V')}>
      {selectedWhiteboardObject?.type === 'image' && <div className="whiteboard-inspector" data-expanded={imageOptionsOpen} onPointerDown={event => event.stopPropagation()}>
        <div className="whiteboard-inspector-title"><strong>{t('تنسيق الصورة')}</strong><small>{t('التغييرات تظهر للطرفين مباشرة')}</small></div>
        <button className="whiteboard-image-options-toggle" type="button" aria-expanded={imageOptionsOpen} onClick={() => setImageOptionsOpen(open => !open)}>{t('تنسيق الصورة')}</button>
        <div className="whiteboard-image-options">
          {selectedWhiteboardObject.documentPages && <div className="whiteboard-document-pages"><strong>{selectedWhiteboardObject.documentName}</strong><span>{t('صفحة {v0} من {v1}', { v0: selectedWhiteboardObject.documentPage || 1, v1: selectedWhiteboardObject.documentPages })}</span>{whiteboardDocument?.itemId === selectedWhiteboardObject.id && <div><button type="button" disabled={whiteboardDocumentBusy || whiteboardDocument.page <= 1} onClick={() => void changeWhiteboardDocumentPage(-1)} aria-label={t('الصفحة السابقة')}><ChevronRight size={16} /></button><button type="button" disabled={whiteboardDocumentBusy || whiteboardDocument.page >= whiteboardDocument.pages} onClick={() => void changeWhiteboardDocumentPage(1)} aria-label={t('الصفحة التالية')}><ChevronLeft size={16} /></button></div>}</div>}
          <div className="whiteboard-inspector-buttons"><button type="button" className={(selectedWhiteboardObject.fit || 'contain') === 'contain' ? 'selected' : ''} onClick={() => updateSelectedWhiteboardItem({ fit: 'contain' })}>{t('احتواء')}</button><button type="button" className={selectedWhiteboardObject.fit === 'cover' ? 'selected' : ''} onClick={() => updateSelectedWhiteboardItem({ fit: 'cover' })}>{t('ملء الإطار')}</button></div>
          <label className="whiteboard-range-field"><span>{t('استدارة الحواف')}</span><input type="range" min="0" max="80" value={selectedWhiteboardObject.borderRadius || 0} onChange={event => updateSelectedWhiteboardItem({ borderRadius: Number(event.target.value) })} /></label>
          <button type="button" onClick={() => whiteboardImageInputRef.current?.click()}><ImagePlus size={16} />{t('إضافة صورة أخرى')}</button>
        <label className="whiteboard-range-field"><span>{t('الشفافية')}</span><input type="range" min="20" max="100" value={Math.round((selectedWhiteboardObject.opacity ?? 1) * 100)} onChange={event => updateSelectedWhiteboardItem({ opacity: Number(event.target.value) / 100 })} /></label>
        </div>
        <div className="whiteboard-inspector-actions"><button type="button" onClick={duplicateWhiteboardItem} aria-label={t('نسخ')}><Copy size={16} /><span>{t('نسخ')}</span></button><button type="button" onClick={() => moveWhiteboardLayer('front')} title={t('إلى الأمام')}><BringToFront size={16} /></button><button type="button" onClick={() => moveWhiteboardLayer('back')} title={t('إلى الخلف')}><SendToBack size={16} /></button><button className="danger" type="button" onClick={() => deleteWhiteboardItem(selectedWhiteboardObject.id)} aria-label={t('حذف العنصر')}><Trash2 size={16} /></button></div>
        <button className="whiteboard-image-options-close" type="button" onClick={() => setSelectedWhiteboardItem(null)} aria-label={t('إغلاق تنسيق الصورة')}><X size={16} /></button>
      </div>}
      <svg ref={whiteboardSvgRef} className={`whiteboard-canvas tool-${whiteboardTool} ${whiteboardTool === 'pan' ? 'panning' : ''}`} viewBox={`${whiteboardViewport.x} ${whiteboardViewport.y} ${viewWidth} ${viewHeight}`} preserveAspectRatio="none" onWheel={handleWhiteboardWheel} onPointerDownCapture={startTextLongPress} onContextMenu={event => event.preventDefault()} onPointerLeave={() => publishPointer(null, true)} onPointerDown={startWhiteboardStroke} onPointerMove={moveWhiteboardStroke} onPointerUp={finishWhiteboardStroke} onPointerCancel={finishWhiteboardStroke} onLostPointerCapture={finishWhiteboardStroke}>
        {whiteboardItems.map(renderWhiteboardItem)}
        {[...whiteboardStrokes, ...(activeStroke ? [activeStroke] : [])].map((stroke) => <WhiteboardStrokePath key={stroke.id} stroke={stroke} />)}
      {renderPointer(localPointer, 'whiteboard')}{renderPointer(remotePointer, 'whiteboard', true)}</svg>
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

  const renderDocumentControls = () => <div className="document-annotation-tools" aria-label={t('أدوات التعليق على الملف')}>
    <div className="document-toolbar-navigation">
      <div className="document-page-navigation">
        <button type="button" disabled={role !== 'teacher' || !sharedDocument || sharedDocument.page <= 1} onClick={() => changeSharedDocumentPage(-1)} title={t('الصفحة السابقة')}><ChevronRight size={17} /></button>
        <div className="document-page-picker"><button type="button" aria-expanded={slidesOpen} onClick={() => setSlidesOpen(open => !open)} title={t('صفحات الملف')}><span dir="ltr">{whiteboardDocumentBusy ? documentTargetPageRef.current : sharedDocument?.page} / {sharedDocument?.pages}</span><ChevronLeft size={14} /></button>{slidesOpen && <div role="listbox" aria-label={t('صفحات الملف')}>{Array.from({ length: sharedDocument?.pages || 0 }, (_, index) => index + 1).map(page => <button type="button" role="option" aria-selected={page === sharedDocument?.page} className={page === sharedDocument?.page ? 'active' : ''} disabled={role !== 'teacher'} key={page} onClick={() => { setSlidesOpen(false); void publishSharedDocumentPage(page).catch(error => setStatus(error.message)); }}>{t('صفحة {v0}', { v0: page })}</button>)}</div>}</div>
        <button type="button" disabled={role !== 'teacher' || !sharedDocument || sharedDocument.page >= sharedDocument.pages} onClick={() => changeSharedDocumentPage(1)} title={t('الصفحة التالية')}><ChevronLeft size={17} /></button>
      </div>
      <div className="document-zoom-controls" role="group" aria-label={t('تكبير وتحريك الملف')}>
        <button type="button" disabled={documentView.zoom <= 1} onClick={() => zoomDocument(1 / 1.25)} title={t('تصغير الملف')}>−</button>
        <button type="button" className="document-zoom-percent" onClick={() => setDocumentView(fitDocumentView)} title={t('عرض الصفحة كاملة')}>{Math.round(documentView.zoom * 100)}%</button>
        <button type="button" disabled={documentView.zoom >= 6} onClick={() => zoomDocument(1.25)} title={t('تكبير الملف')}>+</button>
      </div>
    </div>
    <div className="document-drawing-controls">
      <button type="button" className={documentTool === 'pan' ? 'active' : ''} aria-pressed={documentTool === 'pan'} onClick={() => setDocumentTool('pan')} title={t('تحريك الصفحة')}><Hand size={17} /></button>
      <button type="button" className={documentTool === 'pointer' ? 'active' : ''} aria-pressed={documentTool === 'pointer'} onClick={() => { documentDrawingRef.current = null; setDocumentTool('pointer'); }} title={t('المؤشر الأحمر')}><MousePointer2 size={17} /></button>
      <button type="button" className={documentTool === 'pen' ? 'active' : ''} aria-pressed={documentTool === 'pen'} onClick={() => setDocumentTool('pen')} title={t('قلم')}><Pencil size={17} /></button>
      <button type="button" className={documentTool === 'highlight' ? 'active' : ''} aria-pressed={documentTool === 'highlight'} onClick={() => setDocumentTool('highlight')} title={t('هايلايتر')}><Highlighter size={17} /></button>
      <label title={t('لون الأداة')}><span style={{ background: documentColor }} /><input aria-label={t('لون الأداة')} type="color" value={documentColor} onChange={event => setDocumentColor(event.target.value)} /></label>
      <button type="button" onClick={undoDocumentAnnotation} title={t('تراجع')}><Undo2 size={17} /></button>
      <button type="button" onClick={() => setDocumentView(fitDocumentView)} title={t('عرض الصفحة كاملة')}><Maximize2 size={17} /></button>
      {sharedDocument?.fileUrl && <a href={lessonFileUrl(sharedDocument.fileUrl)} target="_blank" rel="noreferrer" download title={t('تنزيل الملف')}><Download size={17} /></a>}
    </div>
  </div>;
  const documentSurface = () => ({ width: documentPageRef.current?.clientWidth || 1, height: documentPageRef.current?.clientHeight || 1 });
  const documentAnchor = (clientX: number, clientY: number) => {
    const rect = documentPageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };
  const zoomDocument = (factor: number, anchor = { x: 0, y: 0 }) => setDocumentView(view => zoomDocumentView(view, factor, anchor, documentSize, documentSurface()));
  const documentPoint = (event: { clientX: number; clientY: number }) => {
    const svg = documentOverlayRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const transformed = point.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: transformed.x, y: transformed.y };
  };
  const documentPinch = () => {
    const [a, b] = [...documentPointersRef.current.values()];
    return a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), center: documentAnchor((a.x + b.x) / 2, (a.y + b.y) / 2) } : null;
  };
  const startDocumentAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    if (!sharedDocument || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    documentPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (documentPointersRef.current.size >= 2) {
      documentPinchRef.current = documentPinch(); documentPanRef.current = null;
      if (documentDrawingRef.current) { const id = documentDrawingRef.current.id; documentDrawingRef.current = null; publishDocumentAnnotations(documentAnnotationsRef.current.filter(item => item.id !== id), true); }
      return;
    }
    if (documentTool === 'pan' || event.button === 1) {
      const view = documentViewRef.current;
      documentPanRef.current = { clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
      return;
    }
    if (!documentOverlayRef.current?.contains(event.target as Node)) return;
    const point = documentPoint(event);
    if (documentTool === 'pointer') { publishPointer({ ...point, space: 'document', page: sharedDocument.page }, true); return; }
    const annotation: DocumentAnnotation = { id: createWhiteboardId(`document-${documentTool}`), page: sharedDocument.page, kind: documentTool, color: documentColor, size: documentTool === 'highlight' ? 26 : 4, points: [point] };
    documentDrawingRef.current = annotation;
    publishDocumentAnnotations([...documentAnnotationsRef.current, annotation]);
  };
  const moveDocumentAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    const point = documentPoint(event);
    publishPointer(point.x >= 0 && point.x <= 1000 && point.y >= 0 && point.y <= 1400 ? { ...point, space: 'document', page: sharedDocument?.page } : null);
    if (documentPointersRef.current.has(event.pointerId)) documentPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (documentPointersRef.current.size >= 2) {
      const pinch = documentPinch(), previous = documentPinchRef.current;
      if (pinch && previous?.distance) setDocumentView(view => {
        const zoomed = zoomDocumentView(view, pinch.distance / previous.distance, previous.center, documentSize, documentSurface());
        return constrainDocumentView({ ...zoomed, x: zoomed.x + pinch.center.x - previous.center.x, y: zoomed.y + pinch.center.y - previous.center.y }, documentSize, documentSurface());
      });
      documentPinchRef.current = pinch;
      return;
    }
    const pan = documentPanRef.current;
    if (pan) { setDocumentView(view => constrainDocumentView({ ...view, x: pan.x + event.clientX - pan.clientX, y: pan.y + event.clientY - pan.clientY }, documentSize, documentSurface())); return; }
    const active = documentDrawingRef.current;
    if (!active || active.kind === 'text') return;
    const last = active.points.at(-1);
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
    const updated: DocumentAnnotation = { ...active, points: [...active.points, point] };
    documentDrawingRef.current = updated;
    publishDocumentAnnotations(documentAnnotationsRef.current.map(item => item.id === updated.id ? updated : item));
  };
  const finishDocumentAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    documentPointersRef.current.delete(event.pointerId);
    documentPanRef.current = null;
    if (documentPointersRef.current.size < 2) documentPinchRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    if (!documentDrawingRef.current) return;
    documentDrawingRef.current = null;
    publishDocumentAnnotations(documentAnnotationsRef.current, true);
  };
  const wheelDocument = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.defaultPrevented) event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) zoomDocument(Math.exp(-event.deltaY * .003), documentAnchor(event.clientX, event.clientY));
    else setDocumentView(view => constrainDocumentView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY }, documentSize, documentSurface()));
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

  const renderScreenTile = (owner: 'local' | 'remote') => {
    const stream = owner === 'local' ? localScreenStream : remoteScreenStream;
    if (!stream) return null;
    const id = `${owner}-screen` as const;
    return <button type="button" data-tile={id} className={`participant-tile screen share-tile ${focusedParticipant === id ? 'is-focused' : ''}`} aria-label={t('مشاركة شاشة {v0}', { v0: owner === 'local' ? localName : remoteName })} onClick={() => { setStageMode('video'); setFocusedParticipant(value => value === id ? null : id); }}><video ref={owner === 'local' ? localScreenRef : remoteScreenRef} autoPlay muted playsInline /><div className="participant-meta"><ScreenShare size={15} /><span>{owner === 'local' ? localName : remoteName}</span></div></button>;
  };

  const renderTile = (id: 'local' | 'remote', variant: 'grid' | 'focus' | 'pip' = 'grid') => {
    const isLocal = id === 'local';
    const name = isLocal ? localName : remoteName;
    const source: VideoSource = isLocal ? 'camera' : remoteVideoSource;
    const hasStream = isLocal ? isConnected : hasRemoteStream;
    const showVideo = hasStream && (isLocal ? videoEnabled : remoteVideoSource === 'screen' || remoteVideoEnabled);
    const micMuted = isLocal ? !audioEnabled : hasStream && !remoteAudioEnabled;
    const ratio = videoRatios[id];
    return (
      <div role="button" tabIndex={0} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setStageMode('video'); setFocusedParticipant(current => current === id ? null : id); } }} data-tile={id} className={`participant-tile ${focusedParticipant === id ? 'is-focused' : ''} ${variant} ${fitMode === 'fill' ? 'fill-frame' : 'fit-video'} ${source === 'screen' ? 'screen' : ''} ${ratio < 1 ? 'portrait-video' : 'landscape-video'} ${focusedParticipant === id ? 'selected' : ''} ${!micMuted && (isLocal ? localSpeaking : remoteSpeaking) ? 'speaking' : ''}`} onClick={() => { setStageMode('video'); setFocusedParticipant(current => current === id ? null : id); }} aria-label={focusedParticipant === id ? t('العودة إلى العرض الشبكي') : t("تكبير {v0}", { v0: name })} style={{ '--video-ratio': String(ratio) } as CSSProperties}>
        <video ref={isLocal ? bindLocalVideo : bindRemoteVideo} autoPlay muted playsInline onLoadedMetadata={(event) => updateVideoRatio(id, event.currentTarget)} onResize={(event) => updateVideoRatio(id, event.currentTarget)} className={isLocal && source === 'camera' && cameraFacing === 'user' ? 'mirrored-video' : undefined} />
        {isLocal && showVideo && source === 'camera' && <button type="button" className="camera-switch-button" disabled={cameraSwitching} aria-label={t('تبديل الكاميرا الأمامية والخلفية')} title={t('تبديل الكاميرا الأمامية والخلفية')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void handleCameraSwitch(); }}><SwitchCamera size={20} /></button>}
        {!showVideo && <div className="camera-placeholder" aria-hidden="true"><span>{name.slice(0, 1)}{(isLocal ? avatarUrl : remoteProfile?.avatar) ? <img src={apiMediaUrl((isLocal ? avatarUrl : remoteProfile?.avatar)!)} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} /> : null}</span><strong>{isLocal || hasStream || reportedRemotePresent ? name : reportedRemotePresent === null ? t('جارٍ الاتصال') : t("بانتظار الدخول")}</strong><small>{hasStream ? t("الكاميرا مغلقة") : isLocal ? t('جارٍ تجهيز اتصالك') : reportedRemotePresent ? t('داخل الحصة') : reportedRemotePresent === null ? t('جارٍ التحقق من حضور الطرف الآخر') : t("{v0} لم يدخل بعد", { v0: remoteName })}</small></div>}
        {micMuted && <span className="participant-mic-state" role="status" aria-label={t("المايك مغلق")}><MicOff size={18} /></span>}
        <div className="participant-meta"><span>{name}{isLocal ? t(" - أنت") : ''}</span>{micMuted && <MicOff size={15} aria-label={t("المايك مغلق")} />}{hasStream && !showVideo && <CameraOff size={15} aria-label={t("الكاميرا مغلقة")} />}{source === 'screen' && <ScreenShare size={15} aria-label={t("مشاركة شاشة")} />}</div>
      </div>
    );
  };

  const openVideoMode = () => {
    setStageMode('video');
    setFocusedParticipant(null);
    setShowMore(false);
  };

  const toggleWhiteboard = () => {
    if (role !== 'teacher' && !boardOpenRef.current) return;
    if (!boardOpenRef.current) { updateBoardOpen(true); sendWhiteboard({ kind: 'board-session', open: true }); }
    setStageMode('whiteboard');
    if (role === 'teacher') sendWhiteboard({ kind: 'mode', mode: 'whiteboard' });
    setFocusedParticipant(null);
    setSidePanel(null);
    setShowMore(false);
  };
  const closeWhiteboard = () => {
    updateBoardOpen(false);
    if (stageModeRef.current === 'whiteboard') setStageMode(sharedDocumentRef.current ? 'document' : 'video');
    sendWhiteboard({ kind: 'board-session', open: false });
  };
  const cancelMobileTextEdit = () => {
    const item = whiteboardItemsRef.current.find(row => row.id === editingWhiteboardText);
    if (item?.type === 'text' && !item.text.trim()) deleteWhiteboardItem(item.id);
    setEditingWhiteboardText(null);
  };
  const saveMobileTextEdit = () => {
    const item = whiteboardItemsRef.current.find(row => row.id === editingWhiteboardText);
    if (item?.type === 'text' && mobileTextDraft.trim()) {
      const charsPerLine = Math.max(1, Math.floor(item.width / (item.fontSize * .6)));
      const lines = mobileTextDraft.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
      upsertWhiteboardItem({ ...item, text: mobileTextDraft, height: Math.max(item.height, lines * item.fontSize * 1.35 + 16) }, true);
    }
    setEditingWhiteboardText(null);
  };
  const isWindowsDevice = /Windows/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  return (
    <section className={`video-room call-experience ${compact ? 'compact-call' : ''} ${focusedParticipant ? 'focus-mode' : 'grid-mode'} ${sidePanel === 'participants' ? 'panel-open' : ''} ${sidePanel === 'chat' ? 'chat-open' : ''} ${stageMode === 'youtube' ? 'youtube-mode' : stageMode === 'whiteboard' ? 'whiteboard-mode' : stageMode === 'document' ? 'document-mode' : 'video-mode'}`}>
      <audio ref={remoteAudioRef} autoPlay playsInline className="remote-call-audio" />
      {youtubeLinkOpen && <YoutubeLinkDialog onClose={() => setYoutubeLinkOpen(false)} onShare={videoId => { updateYoutube({ videoId, time: 0, playing: true, updatedAt: Date.now() }, true); setYoutubeLinkOpen(false); }} />}
      {mobileWhiteboard && editingWhiteboardText && <dialog className="mobile-whiteboard-text-dialog" aria-label={t('إضافة أو تعديل النص')} ref={node => { mobileTextDialogRef.current = node; if (node && !node.open) { node.showModal(); node.querySelector('textarea')?.focus(); } }} onPointerDownCapture={() => { ignoreEditorOpeningClickRef.current = false; }} onClickCapture={event => { if (ignoreEditorOpeningClickRef.current) { ignoreEditorOpeningClickRef.current = false; event.preventDefault(); event.stopPropagation(); } }} onCancel={event => { event.preventDefault(); cancelMobileTextEdit(); }}><form onSubmit={event => { event.preventDefault(); saveMobileTextEdit(); }}><h2>{t('إضافة أو تعديل النص')}</h2><textarea className="mobile-whiteboard-text-input" autoFocus dir="auto" aria-label={t('نص البورد')} value={mobileTextDraft} onChange={event => setMobileTextDraft(event.target.value)} placeholder={t('اكتب هنا')} /><div><button type="button" onClick={cancelMobileTextEdit}>{t('إلغاء')}</button><button type="submit" disabled={!mobileTextDraft.trim()}>{t('حفظ النص')}</button></div></form></dialog>}
      {remoteAudioBlocked && <button type="button" className="remote-audio-unlock" onClick={() => void resumeRemoteAudio()}><Mic size={18} />{t('اضغط لتشغيل صوت المكالمة')}</button>}
      {role === 'teacher' && <input ref={whiteboardFileInputRef} data-whiteboard-file-input className="whiteboard-image-input call-file-input" type="file"  onChange={handleWhiteboardFileChange} />}
      {!compact && navigationItems.length > 0 && <div className={`call-site-navigation ${siteMenuOpen ? 'open' : ''}`} onMouseLeave={() => setSiteMenuOpen(false)}><button className="call-menu-trigger" type="button" aria-label={t("فتح صفحات المنصة")} aria-expanded={siteMenuOpen} onMouseEnter={() => setSiteMenuOpen(true)} onClick={() => setSiteMenuOpen(value => !value)}><Menu size={22} /></button><nav aria-label={t("صفحات المنصة")}><strong>{t("تصفح المنصة")}</strong><PreferenceControls />{navigationItems.map(item => <button type="button" key={item.id} onClick={() => { setSiteMenuOpen(false); onNavigate?.(item.id); }}>{item.label}</button>)}</nav></div>}
      {compact && <div className="compact-call-header"><button className="call-expand-button" type="button" onClick={onExpand} title={t("العودة إلى المكالمة الكاملة")}><Maximize2 size={17} />{t("تكبير")}</button></div>}

      <div className="session-controls call-start">
        {isConnected && connectionQuality >= 2 && <span className="call-network-notice" role="status">{t(connectionQuality === 3 ? 'النت ضعيف؛ أوقفنا إرسال الفيديو مؤقتًا للحفاظ على الصوت' : 'نخفّض جودة الفيديو للحفاظ على وضوح الصوت')}</span>}
        {isJoining && <span className="call-joining"><RefreshCw size={16} />{t("جار الانضمام")}</span>}
        {!isConnected && !isJoining && <button className="primary-button" type="button" onClick={() => void startCall()}><RefreshCw size={18} />{t("إعادة المحاولة")}</button>}
      </div>
      {showScreenShareNotice && <div className="unsupported-share-panel" role="status"><div><strong>{t('المشاركة أو النافذة العائمة غير متاحة على هذا المتصفح')}</strong><p>{t('حدّث المتصفح أو جرّب Chrome. إذا كان هاتفك يدعم المشاركة والنافذة العائمة ستبقى الحصة ظاهرة أثناء انتقالك بين التطبيقات.')}</p></div><button className="secondary-button" type="button" onClick={() => setShowScreenShareNotice(false)}>{t('حسناً')}</button></div>}

      {documentLoading && <div className="call-document-loading" role="status"><RefreshCw size={18} />{t('جارٍ رفع وتجهيز الملف…')}</div>}
      {boardImage && <BoardImagePreview file={boardImage} onClose={() => setBoardImage(null)} />}
      {mediaError && <p className="call-media-error" role="alert">{mediaError}</p>}
      <div className="call-stage">
        <div className={`video-grid stable-media-grid ${focusedParticipant ? 'has-focus' : ''} ${focusedParticipant ? `${focusedParticipant}-focused` : ''} ${sharedDocument ? 'with-document' : ''} ${!sharedDocument && !boardOpen && !localScreenStream && !remoteScreenStream ? 'camera-only' : ''}`} aria-label={t("المشاركون")}>
          {renderTile('remote')}{renderTile('local')}{renderScreenTile('local')}{renderScreenTile('remote')}
          {sharedDocument && <button type="button" className="shared-document-tile" onClick={() => { setStageMode('document'); setFocusedParticipant(null); }} aria-label={t('تكبير الملف المشترك')}><img src={lessonFileUrl(sharedDocument.src)} alt="" /></button>}
          {youtubeSession && <button type="button" className="shared-document-tile shared-youtube-tile" onClick={() => { setStageMode('youtube'); setFocusedParticipant(null); }} aria-label={t('عرض فيديو يوتيوب')}>▶ YouTube</button>}
          {boardOpen && <button type="button" className="shared-document-tile shared-whiteboard-tile" onClick={() => { setStageMode('whiteboard'); setFocusedParticipant(null); }} aria-label={t('العودة إلى البورد المشترك')}><svg viewBox={`${whiteboardViewport.x} ${whiteboardViewport.y} ${viewWidth} ${viewHeight}`}><rect x={whiteboardViewport.x} y={whiteboardViewport.y} width={viewWidth} height={viewHeight} fill="#fff" />{whiteboardStrokes.map(stroke => <WhiteboardStrokePath key={stroke.id} stroke={stroke} />)}{whiteboardItems.map(item => item.type === 'image' ? <image key={item.id} href={item.src} x={item.x} y={item.y} width={item.width} height={item.height} /> : <text key={item.id} x={item.x + item.width} y={item.y + item.fontSize} textAnchor="end" fontSize={item.fontSize} fill={item.color}>{item.text}</text>)}</svg></button>}
        </div>
        {youtubeSession && <div className="youtube-stage" hidden={stageMode !== 'youtube'}><SharedYoutube session={youtubeSession} canClose={role === 'teacher'} onChange={state => updateYoutube(state, true)} onClose={() => updateYoutube(null, true)} /></div>}
        {stageMode === 'whiteboard' && <div className="whiteboard-stage"><aside className="whiteboard-side-rail">{renderWhiteboardTools()}</aside>{renderWhiteboard()}</div>}
        {stageMode === 'document' && sharedDocument && <div className="document-stage">
          <section className="document-viewer" aria-label={t('عارض الملف')}>
            <header>{renderDocumentControls()}</header>
            <div className={`document-page ${documentTool === 'pan' ? 'pan-tool' : ''}`} ref={documentPageRef} onWheel={wheelDocument} onPointerLeave={event => { if (event.pointerType !== 'touch') publishPointer(null, true); }} onPointerDown={startDocumentAnnotation} onPointerMove={moveDocumentAnnotation} onPointerUp={finishDocumentAnnotation} onPointerCancel={finishDocumentAnnotation}>
              {whiteboardDocumentBusy && <div className="document-page-loading" role="status"><RefreshCw size={15} />{t('جارٍ تجهيز الصفحة…')}</div>}
              <div className="document-page-canvas" style={{ width: documentSize.width * documentView.zoom, height: documentSize.height * documentView.zoom, transform: `translate(${documentView.x}px, ${documentView.y}px)` }}>
                <img onLoad={event => { const image = event.currentTarget; setDocumentRatio(image.naturalWidth / image.naturalHeight || 1); }} draggable={false} src={lessonFileUrl(sharedDocument.src)} alt={t('صفحة {v0} من {v1}', { v0: sharedDocument.page, v1: sharedDocument.pages })} />
                <svg ref={documentOverlayRef} viewBox="0 0 1000 1400" preserveAspectRatio="none">{documentAnnotations.filter(item => item.page === sharedDocument.page).map(item => item.kind === 'text' ? <text key={item.id} x={item.x} y={item.y} fill={item.color} fontSize="34" fontWeight="700" paintOrder="stroke" stroke="#fff" strokeWidth="3">{item.text}</text> : <path key={item.id} d={documentPath(item)} fill="none" stroke={item.color} strokeWidth={item.size} strokeLinecap="round" strokeLinejoin="round" opacity={item.kind === 'highlight' ? .42 : 1} />)}{renderPointer(localPointer, 'document')}{renderPointer(remotePointer, 'document', true)}</svg>
              </div>
            </div>
          </section>
        </div>}
        {sidePanel === 'participants' && <aside className="call-side-panel" aria-label={t("المشاركون")}><div className="panel-title"><strong>{t("المشاركون")}</strong><button type="button" onClick={() => setSidePanel(null)} aria-label={t("إغلاق")}>×</button></div><div className="participant-list"><span>{localName}{t(" - أنت")}{!audioEnabled && <MicOff size={14} aria-label={t('المايك مغلق')} />}</span><span>{hasRemoteStream || reportedRemotePresent ? remoteName : reportedRemotePresent === null ? t('جارٍ التحقق من حضور الطرف الآخر') : t("{v0} بانتظار الدخول", { v0: remoteName })}{hasRemoteStream && !remoteAudioEnabled && <MicOff size={14} aria-label={t('المايك مغلق')} />}</span></div></aside>}
      </div>

      <div className="call-toolbar" aria-label={t("أدوات المكالمة")}>
        <div className="call-toolbar-actions">
        <button className={audioEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleAudioToggle} title={audioEnabled ? t("إيقاف المايك") : t("تشغيل المايك")} type="button">{audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}</button>
        <button className={videoEnabled ? 'tool-button' : 'tool-button muted'} disabled={!isConnected} onClick={handleVideoToggle} title={videoEnabled ? t("إيقاف الكاميرا") : t("تشغيل الكاميرا")} type="button">{videoEnabled ? <Camera size={20} /> : <CameraOff size={20} />}</button>
        {isWindowsDevice && <button className={isScreenSharing ? 'tool-button active-share' : 'tool-button'} disabled={!isConnected} onClick={handleScreenShareToggle} title={isScreenSharing ? t("إيقاف مشاركة الشاشة") : t("مشاركة الشاشة")} type="button">{isScreenSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}</button>}
        <div className={`call-resource-control file-resource ${sharedDocument ? 'is-open' : ''}`}><button className={`tool-button file-share-button ${stageMode === 'document' ? 'active-share' : ''}`} disabled={documentLoading || (!sharedDocument && role !== 'teacher')} onPointerDown={() => { if (!sharedDocument && role === 'teacher') void import('pdfjs-dist'); }} onClick={() => { if (sharedDocument) { setStageMode('document'); setFocusedParticipant(null); } else whiteboardFileInputRef.current?.click(); }} title={sharedDocument ? t('عرض الملف المشترك') : t('عرض ملف كشرائح')} type="button"><FileUp size={20} /><span>{t('ملف')}</span></button>{sharedDocument && role === 'teacher' && <button type="button" className="resource-stop" onClick={closeSharedDocument} title={t('إنهاء مشاركة الملف')} aria-label={t('إنهاء مشاركة الملف')}><X size={14} /><span>{t('إغلاق الملف')}</span></button>}</div>
        <div className={`call-resource-control board-resource ${boardOpen ? 'is-open' : ''}`}><button className={`tool-button ${stageMode === 'whiteboard' ? 'active-share' : ''}`} disabled={role !== 'teacher' && !boardOpen} onClick={toggleWhiteboard} title={role === 'teacher' || boardOpen ? t("اللوح المشترك") : t("اللوح بتحكم الأستاذ")} type="button"><Grid2X2 size={20} /><span>{t('البورد')}</span></button>{boardOpen && role === 'teacher' && <button type="button" className="resource-stop" onClick={closeWhiteboard} title={t('إنهاء مشاركة البورد')} aria-label={t('إنهاء مشاركة البورد')}><X size={14} /><span>{t('إغلاق البورد')}</span></button>}</div>
        <button className={sidePanel === 'chat' ? 'tool-button active-share call-chat-tool' : 'tool-button call-chat-tool'} onClick={() => { if (sidePanel === 'chat') updateLocalTyping(false); setSidePanel(sidePanel === 'chat' ? null : 'chat'); setUnreadCallMessages(0); setShowMore(false); }} title={t("المحادثة")} type="button"><MessageSquare size={20} />{unreadCallMessages > 0 && <span className="call-unread-badge" aria-label={t('{v0} رسائل جديدة', { v0: unreadCallMessages })}>{unreadCallMessages > 9 ? '9+' : unreadCallMessages}</span>}</button>
        {installPrompt && <button className="tool-button" onClick={handleInstallApp} title={t("تثبيت كتطبيق")} type="button"><Download size={20} /></button>}
        <button className={showMore ? 'tool-button active-share' : 'tool-button'} onClick={() => setShowMore(!showMore)} title={t("خيارات أكثر")} type="button"><MoreHorizontal size={20} /></button>
        <button className="tool-button danger" onClick={endCall} title={t("إنهاء المكالمة والخروج")} type="button"><PhoneOff size={20} /></button>
        </div>
        {showMore && <div className="call-more-menu"><button type="button" disabled={!isConnected} onClick={() => { setYoutubeLinkOpen(true); setShowMore(false); }}><ScreenShare size={17} />{t('يوتيوب')}</button><button type="button" onClick={() => { setSidePanel(sidePanel === 'participants' ? null : 'participants'); setShowMore(false); }}><Users size={17} />{t("المشاركون")}</button><button type="button" onClick={openVideoMode}><Grid2X2 size={17} />{t("عرض الفيديو")}</button><button type="button" onClick={() => setFitMode(fitMode === 'fit' ? 'fill' : 'fit')}><MoreHorizontal size={17} />{fitMode === 'fit' ? t('ملء إطار الفيديو') : t('احتواء الفيديو')}</button><button type="button" disabled={!isConnected} onClick={handlePictureInPictureToggle}><PictureInPicture2 size={17} />{t("نافذة عائمة")}</button></div>}
      </div>

      {mutedSpeechWarning && !audioEnabled && <button type="button" className="muted-speaking-warning" onClick={handleAudioToggle}><MicOff size={18} /><span><strong>{t('يبدو أنك تتحدث والمايك مغلق')}</strong><small>{t('اضغط هنا لفك الميوت')}</small></span></button>}
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
