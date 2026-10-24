import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Clipboard, Clock3, CreditCard, ImagePlus, ReceiptText, RefreshCw, Upload, X } from 'lucide-react';
import { date, money, request, requestFile, type WalletData } from '../../services/platformApi';
import { t, usePreferences } from '../../i18n/preferences';
import './wallet.css';

const transactionLabel: Record<string, string> = { cliq_topup: 'شحن عبر كليك', lesson_payment: 'دفع حصة', lesson_refund: 'استرجاع حصة', admin_adjustment: 'تعديل الرصيد من الإدارة' };
const statusLabel: Record<string, string> = { pending: 'قيد المراجعة', approved: 'تمت الإضافة', rejected: 'مرفوض' };

export function WalletPanel({ requiredAmount = 0 }: { requiredAmount?: number }) {
  usePreferences();
  const [data, setData] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);
  const [proof, setProof] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true; let pending = false;
    const load = async (initial = false) => {
      if (pending) return; pending = true;
      if (initial) setLoading(true);
      try { const result = await request<WalletData>('students/wallet'); if (alive) { setData(result); setError(''); } }
      catch (reason) { if (alive && initial) setError((reason as Error).message); }
      finally { pending = false; if (alive && initial) setLoading(false); }
    };
    void load(!data);
    const timer = window.setInterval(() => void load(false), 4000);
    const visible = () => { if (document.visibilityState === 'visible') void load(false); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [revision]);
  useEffect(() => { if (!proof) { setPreview(''); return; } const url = URL.createObjectURL(proof); setPreview(url); return () => URL.revokeObjectURL(url); }, [proof]);
  const shortfall = Math.max(0, requiredAmount - Number(data?.balance || 0));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!proof) { setError(t('اختر صورة الحوالة أولاً.')); return; }
    const fields = new FormData(event.currentTarget); setBusy(true); setError(''); setSuccess('');
    try {
      const result = await requestFile<{ topup: WalletData['topups'][number] }>('students/wallet/topups', proof, { amount: String(fields.get('amount') || ''), reference: String(fields.get('reference') || '') });
      setData(current => current ? { ...current, topups: [result.topup, ...current.topups.filter(row => row.id !== result.topup.id)] } : current);
      setSuccess(t('تم إرسال الحوالة وهي الآن قيد المراجعة.')); setProof(null); event.currentTarget.reset(); setRevision(value => value + 1);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  if (loading) return <section className="wallet-workspace"><div className="wallet-loading"><span className="wake-spinner" />{t('جارٍ تحميل المحفظة…')}</div></section>;
  return <section className="wallet-workspace" aria-label={t('المحفظة')}>
    <header className="wallet-balance-band"><div><span><CreditCard size={19} />{t('رصيدك المتاح')}</span><strong>{money(data?.balance || 0)}</strong></div>{shortfall > 0 && <aside><b>{t('اشحن محفظتك لإكمال عملية الشراء')}</b><span>{t('المبلغ الناقص')} <strong>{money(shortfall)}</strong></span></aside>}</header>
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    <div className="wallet-columns">
      <section className="cliq-topup-panel"><div className="wallet-section-title"><div><h2>{t('شحن المحفظة عبر كليك')}</h2></div><span className="cliq-mark">CliQ</span></div>
        {data?.payment.ready ? <><div className="cliq-alias-card"><span>{t('اسم كليك للتحويل')}</span><strong dir="ltr">{data.payment.cliq_alias}</strong><button type="button" aria-label={t('نسخ اسم كليك')} onClick={() => { void navigator.clipboard.writeText(data.payment.cliq_alias); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}><Clipboard size={18} />{copied ? t('تم النسخ') : t('نسخ')}</button></div><p className="cliq-name-warning" role="note"><strong>{t('تنبيه مهم:')}</strong> {t('اكتب اسم كليك كما يظهر تماماً أعلاه وتأكد منه قبل تأكيد التحويل.')}</p>
          <form className="topup-form" onSubmit={submit}><label>{t('المبلغ المحوّل بالدينار')}<input name="amount" type="number" inputMode="decimal" min="1" max="10000" step="0.001" defaultValue={shortfall ? (shortfall / 100).toFixed(3) : ''} placeholder="10.000" required /></label><label>{t('رقم الحوالة (اختياري)')}<input name="reference" maxLength={100} dir="ltr" /></label><div className="proof-picker"><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { setError(''); setSuccess(''); setProof(event.target.files?.[0] || null); }} />{preview ? <><img src={preview} alt={t('معاينة صورة الحوالة')} /><button className="icon-button" type="button" aria-label={t('إزالة الصورة')} onClick={() => { setError(''); setSuccess(''); setProof(null); if (input.current) input.current.value = ''; }}><X size={18} /></button><div><strong>{proof?.name}</strong><span>{t('صورة الحوالة جاهزة للإرسال')}</span></div></> : <button className="proof-empty" type="button" onClick={() => { setError(''); setSuccess(''); input.current?.click(); }}><ImagePlus size={25} /><span><strong>{t('أرفق صورة الحوالة')}</strong><small>PNG, JPG, WEBP · 5 MB</small></span></button>}</div><button className="primary-button topup-submit" disabled={busy || !proof}><Upload size={18} />{busy ? t('جارٍ الإرسال…') : t('إرسال للمراجعة')}</button></form>
        </> : <div className="cliq-unavailable"><Clock3 size={24} /><strong>{t('الدفع عبر كليك قيد التجهيز')}</strong><p>{t('ستظهر بيانات التحويل هنا فور اعتمادها من الإدارة.')}</p></div>}
      </section>
      <aside className="wallet-activity"><div className="wallet-section-title"><div><span>{t('طلبات الشحن')}</span><h2>{t('حالة حوالاتك')}</h2></div><button className="icon-button" type="button" aria-label={t('تحديث')} onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} /></button></div>
        {!data?.topups.length ? <div className="wallet-empty"><ReceiptText size={25} /><p>{t('لا توجد طلبات شحن بعد.')}</p></div> : <div className="topup-history">{data.topups.map(row => <article key={row.id}><span className={`topup-status ${row.status}`}>{row.status === 'approved' ? <Check size={15} /> : row.status === 'rejected' ? <X size={15} /> : <Clock3 size={15} />}{t(statusLabel[row.status])}</span><strong>{money(row.amount)}</strong><small>{date(row.created)}</small>{row.transfer_reference && <p dir="ltr">#{row.transfer_reference}</p>}{row.rejection_reason && <p className="rejection-reason">{row.rejection_reason}</p>}</article>)}</div>}
        <div className="wallet-ledger"><h3>{t('حركة الرصيد')}</h3>{!data?.transactions.length ? <p>{t('لا توجد حركات مالية بعد.')}</p> : data.transactions.map(row => <div key={row.id}><span><b>{t(transactionLabel[row.type] || row.type)}</b><small>{date(row.created)}</small></span><strong className={row.amount >= 0 ? 'credit' : 'debit'}>{row.amount >= 0 ? '+' : ''}{money(row.amount)}</strong></div>)}</div>
      </aside>
    </div>
  </section>;
}
