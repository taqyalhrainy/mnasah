import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Clipboard, Clock3, CreditCard, ImagePlus, ReceiptText, RefreshCw, Upload, X } from 'lucide-react';
import { date, money, request, requestFile, type WalletData } from '../../services/platformApi';
import { t, usePreferences } from '../../i18n/preferences';
import './wallet.css';

const transactionLabel: Record<string, string> = { cliq_topup: 'شحن عبر كليك', lesson_payment: 'دفع حصة', lesson_refund: 'استرجاع حصة' };
const statusLabel: Record<string, string> = { pending: 'قيد المراجعة', approved: 'تمت الإضافة', rejected: 'مرفوض' };

export function WalletPanel({ requiredAmount = 0 }: { requiredAmount?: number }) {
  usePreferences();
  const [data, setData] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    request<WalletData>('students/wallet').then(result => { if (alive) setData(result); }).catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  useEffect(() => { if (!proof) { setPreview(''); return; } const url = URL.createObjectURL(proof); setPreview(url); return () => URL.revokeObjectURL(url); }, [proof]);
  const shortfall = Math.max(0, requiredAmount - Number(data?.balance || 0));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!proof) { setError(t('اختر صورة الحوالة أولاً.')); return; }
    const fields = new FormData(event.currentTarget); setBusy(true); setError(''); setSuccess('');
    try {
      await requestFile('students/wallet/topups', proof, { amount: String(fields.get('amount') || ''), reference: String(fields.get('reference') || '') });
      setSuccess(t('وصل طلب الشحن. سيظهر الرصيد فور موافقة الإدارة.')); setProof(null); event.currentTarget.reset(); setRevision(value => value + 1);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  if (loading) return <section className="wallet-workspace"><div className="wallet-loading"><span className="wake-spinner" />{t('جارٍ تحميل المحفظة…')}</div></section>;
  return <section className="wallet-workspace" aria-label={t('المحفظة')}>
    <header className="wallet-balance-band"><div><span><CreditCard size={19} />{t('رصيدك المتاح')}</span><strong>{money(data?.balance || 0)}</strong><p>{t('يُخصم سعر الحصة من المحفظة عند تأكيد الحجز.')}</p></div>{shortfall > 0 && <aside><b>{t('أكمل رصيدك للحجز')}</b><span>{t('المبلغ الناقص')} <strong>{money(shortfall)}</strong></span></aside>}</header>
    {error && <p className="notice error" role="alert">{t(error)}</p>}{success && <p className="notice success" role="status">{t(success)}</p>}
    <div className="wallet-columns">
      <section className="cliq-topup-panel"><div className="wallet-section-title"><div><span>{t('شحن عبر كليك')}</span><h2>{t('حوّل، ثم أرسل صورة الحوالة')}</h2></div><span className="cliq-mark">CliQ</span></div>
        {data?.payment.ready ? <><dl className={`cliq-account${data.payment.cliq_name ? '' : ' alias-only'}`}>{data.payment.cliq_name ? <div><dt>{t('اسم المستفيد')}</dt><dd>{data.payment.cliq_name}</dd></div> : null}<div><dt>{t('اسم كليك أو رقم الهاتف')}</dt><dd dir="ltr">{data.payment.cliq_alias}</dd><button type="button" aria-label={t('نسخ بيانات كليك')} onClick={() => { void navigator.clipboard.writeText(data.payment.cliq_alias); setSuccess(t('تم نسخ بيانات كليك.')); }}><Clipboard size={17} /></button></div></dl>
          <ol className="cliq-steps"><li><span>1</span>{t('حوّل المبلغ إلى بيانات كليك الظاهرة.')}</li><li><span>2</span>{t('احتفظ بصورة واضحة لإيصال الحوالة.')}</li><li><span>3</span>{t('أرسل الطلب وانتظر موافقة الإدارة.')}</li></ol>
          <form className="topup-form" onSubmit={submit}><label>{t('المبلغ المحوّل بالدينار')}<input name="amount" type="number" inputMode="decimal" min="1" max="10000" step="0.001" defaultValue={shortfall ? (shortfall / 100).toFixed(3) : ''} placeholder="10.000" required /></label><label>{t('رقم الحوالة (اختياري)')}<input name="reference" maxLength={100} dir="ltr" /></label><div className="proof-picker"><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => setProof(event.target.files?.[0] || null)} />{preview ? <><img src={preview} alt={t('معاينة صورة الحوالة')} /><button className="icon-button" type="button" aria-label={t('إزالة الصورة')} onClick={() => { setProof(null); if (input.current) input.current.value = ''; }}><X size={18} /></button><div><strong>{proof?.name}</strong><span>{t('صورة الحوالة جاهزة للإرسال')}</span></div></> : <button className="proof-empty" type="button" onClick={() => input.current?.click()}><ImagePlus size={25} /><span><strong>{t('أرفق صورة الحوالة')}</strong><small>PNG, JPG, WEBP · 5 MB</small></span></button>}</div><button className="primary-button topup-submit" disabled={busy || !proof}><Upload size={18} />{busy ? t('جارٍ الإرسال…') : t('إرسال للمراجعة')}</button></form>
        </> : <div className="cliq-unavailable"><Clock3 size={24} /><strong>{t('الدفع عبر كليك قيد التجهيز')}</strong><p>{t('ستظهر بيانات التحويل هنا فور اعتمادها من الإدارة.')}</p></div>}
      </section>
      <aside className="wallet-activity"><div className="wallet-section-title"><div><span>{t('طلبات الشحن')}</span><h2>{t('حالة حوالاتك')}</h2></div><button className="icon-button" type="button" aria-label={t('تحديث')} onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} /></button></div>
        {!data?.topups.length ? <div className="wallet-empty"><ReceiptText size={25} /><p>{t('لا توجد طلبات شحن بعد.')}</p></div> : <div className="topup-history">{data.topups.map(row => <article key={row.id}><span className={`topup-status ${row.status}`}>{row.status === 'approved' ? <Check size={15} /> : row.status === 'rejected' ? <X size={15} /> : <Clock3 size={15} />}{t(statusLabel[row.status])}</span><strong>{money(row.amount)}</strong><small>{date(row.created)}</small>{row.transfer_reference && <p dir="ltr">#{row.transfer_reference}</p>}{row.rejection_reason && <p className="rejection-reason">{row.rejection_reason}</p>}</article>)}</div>}
        <div className="wallet-ledger"><h3>{t('حركة الرصيد')}</h3>{!data?.transactions.length ? <p>{t('لا توجد حركات مالية بعد.')}</p> : data.transactions.map(row => <div key={row.id}><span><b>{t(transactionLabel[row.type] || row.type)}</b><small>{date(row.created)}</small></span><strong className={row.amount >= 0 ? 'credit' : 'debit'}>{row.amount >= 0 ? '+' : ''}{money(row.amount)}</strong></div>)}</div>
      </aside>
    </div>
  </section>;
}
