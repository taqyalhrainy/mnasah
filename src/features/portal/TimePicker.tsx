import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, X } from 'lucide-react';
import { locale, t } from '../../i18n/preferences';

const wrap = (value: number, length: number) => (value % length + length) % length;
const hours = Array.from({ length: 12 }, (_, index) => index + 1);
const minutes = [0, 15, 30, 45];
const format = (value: number) => value.toLocaleString(locale(), { minimumIntegerDigits: 2 });

export function CyclicTimeColumn({ label, values, value, onChange }: { label: string; values: number[]; value: number; onChange: (value: number) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  const middle = values.length * 4;
  const [index, setIndex] = useState(middle + Math.max(0, values.indexOf(value)));
  useLayoutEffect(() => { if (rail.current) rail.current.scrollTop = index * 44; }, []);
  const move = (next: number) => rail.current?.scrollTo({ top: next * 44, behavior: 'smooth' });
  return <div className="clock-column"><span>{label}</span><div className="clock-wheel" ref={rail} role="spinbutton" tabIndex={0} aria-label={label} aria-valuenow={value} aria-valuemin={Math.min(...values)} aria-valuemax={Math.max(...values)} onKeyDown={event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(index + (event.key === 'ArrowDown' ? 1 : -1)); }
  }} onScroll={event => {
    const element = event.currentTarget;
    const next = Math.round(element.scrollTop / 44);
    setIndex(next); onChange(values[wrap(next, values.length)]);
    if (next < values.length || next >= values.length * 7) {
      const centered = middle + wrap(next, values.length);
      element.scrollTop = centered * 44; setIndex(centered);
    }
  }}><div className="clock-wheel-options">{Array.from({ length: values.length * 9 }, (_, position) => <button type="button" tabIndex={-1} aria-hidden="true" key={position} className={position === index ? 'selected' : ''} onClick={() => move(position)}>{format(values[position % values.length])}</button>)}</div></div></div>;
}

export function TimePicker({ label, value, onChange, note = '' }: { label: string; value: string; onChange: (value: string) => void; note?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const trigger = useRef<HTMLButtonElement>(null);
  const [hour24, minute] = draft.split(':').map(Number);
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const display = (clock: string) => new Date(`2000-01-01T${clock}`).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  const update = (hour = hour12, nextMinute = minute, nextPeriod = period) => setDraft(`${String(hour % 12 + (nextPeriod === 'PM' ? 12 : 0)).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className={`time-wheel ${open ? 'open' : ''}`}><span>{label}</span><button ref={trigger} className="time-wheel-trigger" type="button" data-value={value} aria-label={label} aria-expanded={open} onClick={() => { setDraft(value); setOpen(true); }}><Clock3 size={17} /><strong>{display(value)}</strong></button>{note && <small className="next-day-note">{note}</small>}
    {open && createPortal(<div className="time-wheel-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}><dialog open className="clock-picker-dialog" aria-modal="true" aria-label={`${t('اختيار الوقت')} ${label}`} onKeyDown={event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const items = event.currentTarget.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), [role="spinbutton"]');
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><span>{t('اختيار الوقت')}</span><h3>{label}</h3></div><button autoFocus className="clock-close" type="button" aria-label={t('إغلاق')} onClick={close}><X size={20} /></button></header>
      <div className="clock-preview"><Clock3 size={20} /><strong>{display(draft)}</strong></div>
      <div className="clock-columns" dir="ltr"><CyclicTimeColumn label={t('الساعة')} values={hours} value={hour12} onChange={hour => update(hour)} /><b>:</b><CyclicTimeColumn label={t('الدقائق')} values={minutes} value={minute} onChange={next => update(hour12, next)} /></div>
      <div className="clock-period">{(['AM', 'PM'] as const).map(item => <button type="button" aria-pressed={period === item} className={period === item ? 'selected' : ''} onClick={() => update(hour12, minute, item)} key={item}>{t(item === 'AM' ? 'صباحًا' : 'مساءً')}</button>)}</div>
      <p className="clock-help">{t('اسحب الأرقام لاختيار الوقت · كل ربع ساعة')}</p><button className="clock-confirm" type="button" onClick={() => { onChange(draft); close(); }}>{t('تأكيد الوقت')}</button>
    </dialog></div>, document.body)}
  </div>;
}
