import { useEffect, useRef, useState } from 'react';
import { MicOff, Volume2, ScreenShare } from 'lucide-react';
import { t } from '../../i18n/preferences';
import type { GroupParticipant } from '../../services/groupVideoConnection';

export function GroupParticipantTile({ participant, onSelect }: { participant: GroupParticipant; onSelect: () => void }) {
  const video = useRef<HTMLVideoElement>(null), audio = useRef<HTMLAudioElement>(null), screen = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (video.current) { video.current.srcObject = participant.stream; void video.current.play().catch(() => undefined); }
    if (audio.current) audio.current.srcObject = participant.stream;
    const play = () => { void audio.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true)); };
    play();
    document.addEventListener('pointerdown', play); document.addEventListener('keydown', play);
    return () => { document.removeEventListener('pointerdown', play); document.removeEventListener('keydown', play); };
  }, [participant.stream]);
  useEffect(() => { if (screen.current) { screen.current.srcObject = participant.screenStream; void screen.current.play().catch(() => undefined); } }, [participant.screenStream, participant.screenEnabled]);
  return <>
    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={event => { if (event.key === 'Enter') onSelect(); }} data-group-peer={participant.memberId} className={`participant-tile grid fit-video ${participant.speaking && participant.audioEnabled ? 'speaking' : ''}`}>
      <video ref={video} autoPlay muted playsInline style={{ opacity: participant.videoEnabled ? 1 : 0 }} />
      <audio ref={audio} autoPlay />
      {!participant.videoEnabled && <div className="camera-placeholder"><span>{participant.name.slice(0, 1)}</span><strong>{participant.name}</strong><small>{t('الكاميرا مغلقة')}</small></div>}
      {!participant.audioEnabled && <span className="participant-mic-badge"><MicOff size={18} aria-label={t('المايك مغلق')} /></span>}
      <div className="participant-meta"><span>{participant.name}</span>{!participant.audioEnabled && <MicOff size={14} />}</div>
      {blocked && <button type="button" className="group-audio-unlock" onClick={event => { event.stopPropagation(); void audio.current?.play().then(() => setBlocked(false)).catch(() => undefined); }}><Volume2 size={17} />{t('تشغيل الصوت')}</button>}
    </div>
    {participant.screenEnabled && <button type="button" className="participant-tile screen share-tile" onClick={onSelect}><video ref={screen} muted autoPlay playsInline /><div className="participant-meta"><ScreenShare size={15} />{participant.name}</div></button>}
  </>;
}
