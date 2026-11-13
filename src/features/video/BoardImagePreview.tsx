import { useEffect, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { t } from '../../i18n/preferences';
import { downloadBoardImage } from './whiteboardExport';

export function BoardImagePreview({ file, onClose }: { file: File; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canShare = !!navigator.canShare?.({ files: [file] });
  useEffect(() => { const value = URL.createObjectURL(file); setUrl(value); return () => URL.revokeObjectURL(value); }, [file]);
  async function share() {
    setBusy(true); setFailed(false);
    try { await navigator.share({ files: [file] }); }
    catch (error) { if ((error as Error).name !== 'AbortError') setFailed(true); }
    finally { setBusy(false); }
  }
  return <div className="board-image-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><dialog open className="board-image-preview" aria-modal="true" aria-labelledby="board-image-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header><h2 id="board-image-title">{t('صورة البورد')}</h2><button type="button" autoFocus onClick={onClose} aria-label={t('إغلاق')}><X size={20} /></button></header>
    {url && <img src={url} alt={t('صورة البورد')} />}
    <p>{t('لحفظها في الألبوم، اختر «حفظ الصورة» من قائمة المشاركة. ويمكنك الضغط مطولاً على الصورة لحفظها.')}</p>
    {failed && <p role="alert">{t('تعذرت المشاركة. اضغط مطولاً على الصورة واختر حفظ الصورة، أو نزّل ملف PNG.')}</p>}
    <footer>{canShare && <button type="button" disabled={busy} onClick={() => void share()}><Share2 size={18} />{t('حفظ الصورة في الصور')}</button>}<button type="button" onClick={() => downloadBoardImage(file)}><Download size={18} />{t('تنزيل PNG')}</button></footer>
  </dialog></div>;
}
