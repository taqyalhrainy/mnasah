import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Clipboard, Clock3, CreditCard, ImagePlus, ReceiptText, RefreshCw, ShieldCheck, Upload, WalletCards, X } from 'lucide-react';
import { date, money, request, requestFile, type WalletData, type PayPalOrder } from '../../services/platformApi';
import { t, usePreferences } from '../../i18n/preferences';
import './wallet.css';

const transactionLabel: Record<string, string> = { cliq_topup: 'شحن عبر كليك', paypal_topup: 'شحن عبر PayPal', paypal_refund: 'استرجاع دفعة PayPal', lesson_payment: 'دفع حصة', lesson_refund: 'استرجاع حصة', package_purchase: 'شراء باقة', admin_adjustment: 'تعديل الرصيد من الإدارة' };
const statusLabel: Record<string, string> = { pending: 'قيد المراجعة', approved: 'تمت الإضافة', rejected: 'مرفوض', refunded: 'مسترجع' };

export function WalletPanel({ requiredAmount = 0 }: { requiredAmount?: number }) {
  usePreferences();
  const [data, setData] = useState<WalletData | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const [proof, setProof] = useState<File | null>(null), [preview, setPreview] = useState('');
  const [submitted, setSubmitted] = useState(false), [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'charge' | 'history'>('charge'), [method, setMethod] = useState<'cliq' | 'paypal'>('cliq');
  const [amount, setAmount] = useState('10'), [showAll, setShowAll] = useState(false);
  const [returnOrder] = useState(() => { const q = new URLSearchParams(location.search); return q.get('paypal') === 'return' ? q.get('order') || '' : ''; });
  const [paypalStatus, setPaypalStatus] = useState('');
  const input = useRef<HTMLInputElement>(null), prefilled = useRef(false);
  useEffect(() => {
    let alive = true, pending = false;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const result = await request<WalletData>('students/wallet');
        if (alive) { setData(result); if (!prefilled.current) { const missing = Math.max(0, requiredAmount - result.balance); if (missing) setAmount((missing / 100).toFixed(2)); prefilled.current = true; } }
      } catch (reason) { if (alive) setError((reason as Error).message); }
      finally { pending = false; if (alive) setLoading(false); }
    };
    void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 4000);
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [revision, requiredAmount]);
  useEffect(() => {
    if (!returnOrder) return;
    let alive = true, pending = false, done = false; setTab('history');
    const check = async () => {
      if (pending || done) return; pending = true;
      try { const result = await request<{ order: PayPalOrder }>(`students/wallet/paypal/${encodeURIComponent(returnOrder)}`); if (alive) { setPaypalStatus(result.order.status); if (result.order.status !== 'pending') { done = true; setRevision(v => v + 1); } } }
      catch (reason) { if (alive) { setError((reason as Error).message); setPaypalStatus('unavailable'); done = true; } } finally { pending = false; }
    };
    void check(); const timer = setInterval(() => void check(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [returnOrder]);
  useEffect(() => { if (!proof) { setPreview(''); return; } const url = URL.createObjectURL(proof); setPreview(url); return () => URL.revokeObjectURL(url); }, [proof]);
  const shortfall = Math.max(0, requiredAmount - Number(data?.balance || 0));
  const cents = /^\d+(?:\.\d{0,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : 0;
  const valid = cents >= 100 && cents <= 1000000;
  const usd = (Math.ceil(cents / (data?.payment.paypal?.jod_per_usd || .709) - 1e-8) / 100).toFixed(2);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!valid || !proof) return;
    const form = event.currentTarget, fields = new FormData(form); setBusy(true); setError('');
    try { await requestFile('students/wallet/topups', proof, { amount: (cents / 100).toFixed(2), reference: String(fields.get('reference') || '') }); setSubmitted(true); setProof(null); form.reset(); setTab('history'); setRevision(v => v + 1); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  async function pay() {
    if (!valid) return; setBusy(true); setError('');
    try { const result = await request<{ checkout_url: string }>('students/wallet/paypal', { amount: (cents / 100).toFixed(2) }); const url = new URL(result.checkout_url); if (url.protocol !== 'https:' || !['www.paypal.com', 'www.sandbox.paypal.com'].includes(url.hostname)) throw new Error(t('تعذر فتح صفحة الدفع. حاول مجدداً.')); location.assign(url.href); }
    catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  if (loading) return <section className="wallet-workspace"><div className="wallet-loading"><span className="wake-spinner" />{t('جارٍ تحميل المحفظة…')}</div></section>;
  const supportNumber = data?.payment.support_whatsapp || '0795764229', supportLink = `https://wa.me/${supportNumber.replace(/\D/g, '').replace(/^0/, '962')}`;
  const orders = [...(data?.topups.map(row => ({ ...row, method: 'CliQ', reason: row.rejection_reason })) || []), ...(data?.paypal_orders?.map(row => ({ ...row, method: 'PayPal', reason: '' })) || [])].sort((a, b) => b.created - a.created);
  const pendingCount = orders.filter(row => row.status === 'pending').length;
  return <section className="wallet-workspace simple-wallet" aria-label={t('المحفظة')}>
    {submitted && <dialog ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSubmitted(false)} className="topup-submitted-dialog"><span className="topup-submitted-icon"><Check size={28} /></span><h2>{t('تم إرسال الطلب')}</h2><p>{t('تم إرسال الطلب، وهو الآن بانتظار التحقق.')}</p><p>{t('لاستجابة أسرع ابعث رسالة على رقم الدعم الفني.')}</p><a href={supportLink} target="_blank" rel="noopener noreferrer" dir="ltr">{supportNumber}</a><button className="primary-button" onClick={() => setSubmitted(false)}>{t('حسناً')}</button></dialog>}
    <header className="wallet-balance-band"><div><span><WalletCards size={20} />{t('رصيدك المتاح')}</span><strong>{money(data?.balance || 0)}</strong>{pendingCount > 0 && <button className="wallet-pending-link" onClick={() => setTab('history')}>{t('طلبات بانتظار التأكيد: {v0}', { v0: pendingCount })}</button>}</div>{shortfall > 0 && <aside><b>{t('المبلغ الناقص لإتمام الحجز')}</b><strong>{money(shortfall)}</strong></aside>}</header>
    <nav className="wallet-tabs" aria-label={t('المحفظة')}><button aria-pressed={tab === 'charge'} onClick={() => setTab('charge')}><CreditCard size={18} />{t('شحن الرصيد')}</button><button aria-pressed={tab === 'history'} onClick={() => setTab('history')}><ReceiptText size={18} />{t('سجل المحفظة')}</button></nav>
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    {returnOrder && (!paypalStatus || paypalStatus === 'pending') && <p className="wallet-payment-notice" role="status"><Clock3 size={19} />{t('بانتظار تأكيد PayPal. سيُضاف الرصيد تلقائياً بعد اكتمال الدفع.')}</p>}
    {returnOrder && paypalStatus === 'approved' && <p className="notice success" role="status">{t('تم تأكيد الدفع وإضافة الرصيد إلى محفظتك.')}</p>}
    {tab === 'charge' ? <section className="wallet-charge-card">
      <div className="wallet-section-title"><div><h2>{t('اشحن محفظتك')}</h2><span>{t('اختر المبلغ وطريقة الدفع')}</span></div></div>
      <label className="wallet-amount-label" htmlFor="wallet-topup-amount">{t('المبلغ بالدينار')}</label><div className="wallet-amount-input"><input id="wallet-topup-amount" type="number" inputMode="decimal" min="1" max="10000" step="0.01" value={amount} onChange={e => { setAmount(e.target.value); setError(''); }} /><span>{t('د.أ')}</span></div>
      <div className="wallet-quick-amounts">{[5, 10, 20, 50].map(value => <button aria-pressed={Number(amount) === value} key={value} onClick={() => { setAmount(String(value)); setError(''); }}>{money(value * 100)}</button>)}</div>
      <div className="wallet-payment-methods" role="group" aria-label={t('طريقة الدفع')}><button aria-pressed={method === 'cliq'} onClick={() => { setMethod('cliq'); setError(''); }}><span className="wallet-method-brand">CliQ</span><span><strong>{t('كليك')}</strong><small>{t('تحويل وإرفاق إيصال')}</small></span>{method === 'cliq' && <Check size={18} />}</button><button aria-pressed={method === 'paypal'} onClick={() => { setMethod('paypal'); setError(''); }}><CreditCard size={25} /><span><strong>{t('بطاقة بنكية / PayPal')}</strong><small>{t('دفع آمن عبر PayPal')}</small></span>{method === 'paypal' && <Check size={18} />}</button></div>
      {method === 'cliq' ? data?.payment.ready ? <div className="wallet-method-content">
        <div className="cliq-alias-card"><span>{t('حوّل المبلغ إلى اسم كليك')}</span><strong dir="ltr">{data.payment.cliq_alias}</strong><small>{t('باسم')} <b>{data.payment.cliq_name || 'تقي الله الهريني'}</b></small><button onClick={async () => { try { await navigator.clipboard.writeText(data.payment.cliq_alias); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError(t('تعذر النسخ. انسخ اسم كليك يدوياً.')); } }}><Clipboard size={17} />{copied ? t('تم النسخ') : t('نسخ')}</button></div>
        <form className="topup-form" onSubmit={submit}><div className="proof-picker"><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { setError(''); setProof(e.target.files?.[0] || null); }} />{preview ? <><img src={preview} alt={t('معاينة صورة الحوالة')} /><button className="icon-button" type="button" aria-label={t('إزالة الصورة')} onClick={() => { setProof(null); if (input.current) input.current.value = ''; }}><X size={18} /></button><div><strong>{proof?.name}</strong><span>{t('صورة الحوالة جاهزة للإرسال')}</span></div></> : <button className="proof-empty" type="button" onClick={() => input.current?.click()}><ImagePlus size={24} /><span><strong>{t('أرفق صورة الحوالة')}</strong><small>PNG, JPG, WEBP · 5 MB</small></span></button>}</div><details className="wallet-transfer-reference"><summary>{t('رقم الحوالة (اختياري)')}</summary><input name="reference" maxLength={100} dir="ltr" aria-label={t('رقم الحوالة (اختياري)')} /></details><button className="primary-button topup-submit" disabled={busy || !proof || !valid}><Upload size={18} />{busy ? t('جارٍ الإرسال…') : t('إرسال للمراجعة')}</button></form>
      </div> : <p className="wallet-payment-notice">{t('الدفع عبر كليك قيد التجهيز')}</p> : <div className="wallet-method-content paypal-checkout-panel">
        <div className="paypal-charge-summary jod-primary"><span>{t('يُضاف إلى محفظتك')}<strong>{money(valid ? cents : 0)}</strong></span></div>
        <details className="paypal-currency-details"><summary>{t('تفاصيل الدفع وعملة الخصم')}</summary><strong dir="ltr">{valid ? usd : '0.00'} USD</strong><p>{t('الدفع بالدولار، ورصيد المحفظة بالدينار. يظهر المبلغ النهائي لدى PayPal قبل الدفع.')}</p></details>
        <p className="wallet-card-note">{t('اختر الدفع ببطاقة كضيف في PayPal إذا ظهر الخيار، دون تسجيل الدخول إلى حساب PayPal.')}</p>
        <button className="primary-button paypal-pay-button" disabled={busy || !valid || !data?.payment.paypal?.ready} onClick={() => void pay()}><ShieldCheck size={18} />{busy ? t('جارٍ فتح صفحة الدفع…') : t('متابعة إلى PayPal')}</button>{!data?.payment.paypal?.ready && <p className="wallet-card-note">{t('الدفع عبر PayPal قيد التجهيز')}</p>}
      </div>}
    </section> : <section className="wallet-activity"><div className="wallet-section-title"><h2>{t('سجل المحفظة')}</h2><button className="icon-button" aria-label={t('تحديث')} onClick={() => setRevision(v => v + 1)}><RefreshCw size={17} /></button></div>
      <details className="wallet-request-history" open={pendingCount > 0 || undefined}><summary>{t('طلبات الشحن')}<span>{orders.length}</span></summary>{!orders.length ? <p className="wallet-empty">{t('لا توجد طلبات شحن بعد.')}</p> : <div className="topup-history">{orders.map(row => <article key={row.id}><span className={`topup-status ${row.status}`}>{row.status === 'approved' ? <Check size={15} /> : <Clock3 size={15} />}{t(row.method === 'PayPal' && row.status === 'pending' ? 'بانتظار الدفع أو تأكيده' : statusLabel[row.status])}</span><strong>{money(row.amount)}</strong><small>{row.method} · {date(row.created)}</small>{row.reason && <p className="rejection-reason">{row.reason}</p>}</article>)}</div>}</details>
      <div className="wallet-ledger"><h3>{t('حركة الرصيد')}</h3>{!data?.transactions.length ? <p>{t('لا توجد حركات مالية بعد.')}</p> : (showAll ? data.transactions : data.transactions.slice(0, 8)).map(row => <div key={row.id}><span><b>{t(transactionLabel[row.type] || row.type)}</b><small>{date(row.created)}</small></span><strong className={row.amount >= 0 ? 'credit' : 'debit'}>{row.amount >= 0 ? '+' : ''}{money(row.amount)}</strong></div>)}{(data?.transactions.length || 0) > 8 && <button className="text-button" onClick={() => setShowAll(v => !v)}>{showAll ? t('عرض أقل') : t('عرض المزيد')}</button>}</div>
    </section>}
  </section>;
}
