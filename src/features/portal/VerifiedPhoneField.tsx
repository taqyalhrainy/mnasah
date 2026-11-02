import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, ExternalLink, KeyRound, Phone, RefreshCw } from 'lucide-react';
import { request } from '../../services/platformApi';
import { t } from '../../i18n/preferences';

const normalized = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (/^9627[789]\d{7}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^7[789]\d{7}$/.test(digits)) return `0${digits}`;
  return /^07[789]\d{7}$/.test(digits) ? digits : '';
};

type PhoneCodeResult = { id: string; channel: string; destination: string; debugCode?: string; claimToken?: string; reference?: string; whatsappUrl?: string };

export function VerifiedPhoneField({ initialValue = '' }: { initialValue?: string }) {
  const [phone, setPhone] = useState(initialValue);
  const [provider, setProvider] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [reference, setReference] = useState('');
  const [whatsappUrl, setWhatsappUrl] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const changed = useMemo(() => normalized(phone) !== normalized(initialValue), [initialValue, phone]);

  useEffect(() => {
    let alive = true;
    void request<{ phoneVerificationProvider?: string }>('public/config').then(config => {
      if (alive) setProvider(config.phoneVerificationProvider || '');
    }).catch(() => { if (alive) setProvider(''); });
    return () => { alive = false; };
  }, []);

  const clearVerification = () => {
    setVerificationId(''); setVerificationCode(''); setReference(''); setWhatsappUrl(''); setApproved(false); setHint('');
  };

  const sendCode = async () => {
    setBusy(true); setHint('');
    try {
      const result = await request<PhoneCodeResult>('auth/phone-code', { phone });
      setVerificationId(result.id);
      setReference(result.reference || '');
      setWhatsappUrl(result.whatsappUrl || '');
      setVerificationCode(result.claimToken || result.debugCode || '');
      setApproved(false);
      setHint(result.channel === 'whatsapp_manual' ? 'أرسل الرسالة الجاهزة من الرقم نفسه، ثم انتظر اعتماد الدعم.' : `أرسلنا رمزاً إلى ${result.destination}.`);
    } catch (cause) { setHint((cause as Error).message); }
    finally { setBusy(false); }
  };

  const checkApproval = useCallback(async () => {
    if (!verificationId || !verificationCode || provider !== 'whatsapp_manual') return;
    try {
      const result = await request<{ verified: boolean }>('auth/phone-code-status', { id: verificationId, claimToken: verificationCode, phone });
      setApproved(result.verified);
      if (result.verified) setHint('تم توثيق الرقم. اضغط حفظ لتثبيت التغيير.');
    } catch (cause) { setHint((cause as Error).message); }
  }, [phone, provider, verificationCode, verificationId]);

  useEffect(() => {
    if (!verificationId || provider !== 'whatsapp_manual' || approved) return;
    const timer = window.setInterval(() => void checkApproval(), 5000);
    return () => window.clearInterval(timer);
  }, [approved, checkApproval, provider, verificationId]);

  return <div className="profile-phone-control">
    <label>{t('رقم الهاتف')}
      <span className="field-with-icon"><Phone size={17} /><input name="phone" dir="ltr" inputMode="tel" autoComplete="tel" value={phone} placeholder="079 123 4567" onChange={event => { setPhone(event.target.value); clearVerification(); }} required /></span>
    </label>
    <input type="hidden" name="phone_verification_id" value={verificationId} />
    <input type="hidden" name="phone_verification_code" value={verificationCode} />
    {!changed ? <p className="phone-current-status"><BadgeCheck size={17} />{t('هذا هو رقم التواصل الموثّق في حسابك.')}</p> : <div className={`phone-verification-box${approved ? ' verified' : ''}`}>
      <button className="secondary-button" type="button" disabled={busy || !normalized(phone)} onClick={() => void sendCode()}><Phone size={17} />{busy ? t('جاري الإرسال…') : verificationId ? t('إعادة إرسال التحقق') : provider === 'whatsapp_manual' ? t('تحقق من الرقم') : t('إرسال رمز التحقق')}</button>
      {verificationId && provider !== 'whatsapp_manual' && <label>{t('رمز التحقق')}<span className="field-with-icon"><KeyRound size={17} /><input dir="ltr" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={verificationCode} onChange={event => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></span></label>}
      {verificationId && provider === 'whatsapp_manual' && <div className="manual-phone-verification"><strong>{approved ? <><BadgeCheck size={17} />{t('رقم الهاتف موثّق')}</> : t('مرجع الطلب: {v0}', { v0: reference })}</strong>{!approved && <><a className="primary-button" href={whatsappUrl} target="_blank" rel="noreferrer"><ExternalLink size={17} />{t('فتح واتساب وإرسال الرسالة')}</a><button className="secondary-button" type="button" onClick={() => void checkApproval()}><RefreshCw size={16} />{t('فحص الموافقة')}</button></>}</div>}
      {hint && <small role="status">{t(hint)}</small>}
    </div>}
  </div>;
}
