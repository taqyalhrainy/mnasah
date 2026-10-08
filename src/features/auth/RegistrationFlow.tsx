import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, Camera, Check, FileCheck2, GraduationCap, LoaderCircle, Phone, ShieldCheck, Upload, UserRound, Video, X } from 'lucide-react';
import { direction, t, usePreferences } from '../../i18n/preferences';
import { request, requestFile, type Portal, type User, type VerificationFile } from '../../services/platformApi';

const qualifications = ['دبلوم متوسط', 'بكالوريوس', 'دبلوم عالٍ', 'ماجستير', 'دكتوراه', 'رخصة مزاولة تعليم', 'شهادة تدريب مهني', 'إجازة في القرآن الكريم', 'أخرى'];
const teachingLanguages = ['العربية', 'الإنجليزية', 'الفرنسية', 'الألمانية', 'أخرى'];
const initial = { first_name: '', father_name: '', family_name: '', birth_date: '', gender: '', phone: '', email: '', password: '', confirm_password: '', other_qualification: '', years_experience: '0', national_id_last4: '', professional_bio: '', accept_terms: false, confirm_accuracy: false, accept_teaching_policy: false };
type Fields = typeof initial;

function age(value: string) {
  if (!value) return null; const born = new Date(`${value}T00:00:00`); if (!Number.isFinite(born.getTime())) return null;
  const now = new Date(); let result = now.getFullYear() - born.getFullYear(); if (now.getMonth() < born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())) result--; return result;
}
function validJordanPhone(value: string) { return /^(?:\+?962|0)7[789]\d{7}$/.test(value.replace(/[\s()-]/g, '')); }
function decodeGoogleName(credential: string) { try { return JSON.parse(atob(credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } }

function GoogleLink({ onCredential }: { onCredential: (credential: string, profile: { email?: string; given_name?: string; family_name?: string }) => void }) {
  const host = useRef<HTMLDivElement>(null); const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  useEffect(() => {
    if (!clientId || !host.current) return;
    let cancelled = false;
    const render = () => {
      const google = (window as unknown as { google?: { accounts: { id: { initialize: (value: object) => void; renderButton: (node: HTMLElement, value: object) => void } } } }).google;
      if (!google || cancelled || !host.current) return;
      google.accounts.id.initialize({ client_id: clientId, callback: ({ credential }: { credential: string }) => onCredential(credential, decodeGoogleName(credential)) });
      host.current.replaceChildren(); google.accounts.id.renderButton(host.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(360, host.current.clientWidth || 360) });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-mansah-google]');
    if (existing) { if ((window as unknown as { google?: unknown }).google) render(); else existing.addEventListener('load', render, { once: true }); }
    else { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; script.dataset.mansahGoogle = 'true'; script.onload = render; document.head.append(script); }
    return () => { cancelled = true; };
  }, [clientId, onCredential]);
  return <div className="registration-google"><div ref={host} />{!clientId && <small>{t('يتطلب تسجيل Google إضافة مفتاح Google Client ID إلى إعدادات الخادم.')}</small>}</div>;
}

export function RegistrationFlow({ portal, onLogin, onCancel, existingUser }: { portal: Exclude<Portal, 'admin'>; onLogin: (user: User) => void; onCancel: () => void; existingUser?: User }) {
  usePreferences(); const teacher = portal === 'teachers'; const steps = teacher ? [t('الهوية'), t('الحساب'), t('المؤهلات'), t('التحقق المرئي')] : [t('الهوية'), t('الحساب')];
  const verification = existingUser?.verification;
  const [step, setStep] = useState(existingUser && teacher ? 3 : 0); const [fields, setFields] = useState<Fields>(() => ({ ...initial, first_name: verification?.first_name || '', father_name: verification?.father_name || '', family_name: verification?.family_name || '', birth_date: verification?.birth_date || '', gender: verification?.gender || '', phone: verification?.phone || '', email: existingUser?.email || '', other_qualification: verification?.other_qualification || '', years_experience: String(verification?.years_experience || 0), national_id_last4: verification?.national_id_last4 || '', professional_bio: verification?.professional_bio || '', accept_terms: Boolean(existingUser), confirm_accuracy: Boolean(existingUser), accept_teaching_policy: Boolean(existingUser) })); const [selectedQualifications, setSelectedQualifications] = useState<string[]>(verification?.qualifications || []); const [languages, setLanguages] = useState<string[]>(verification?.teaching_languages || ['العربية']);
  const [photo, setPhoto] = useState<File | null>(null); const [credentials, setCredentials] = useState<File[]>([]); const [videoFile, setVideoFile] = useState<File | null>(null); const [googleCredential, setGoogleCredential] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [createdUser, setCreatedUser] = useState<User | null>(existingUser || null); const [remoteFiles, setRemoteFiles] = useState<VerificationFile[]>([]); const [recording, setRecording] = useState(false); const [recordedSeconds, setRecordedSeconds] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null); const streamRef = useRef<MediaStream | null>(null); const recorderRef = useRef<MediaRecorder | null>(null); const timerRef = useRef<number | null>(null); const chunksRef = useRef<Blob[]>([]); const uploadedRef = useRef(new Set<string>());
  const computedAge = age(fields.birth_date); const fullName = [fields.first_name, fields.father_name, fields.family_name].filter(Boolean).join(' '); const phrase = `أنا ${fullName || 'الاسم الكامل'}، وأتقدم للتدريس في منصّة`;
  const photoPreview = useMemo(() => photo ? URL.createObjectURL(photo) : '', [photo]);
  const videoPreview = useMemo(() => videoFile ? URL.createObjectURL(videoFile) : '', [videoFile]);
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);
  useEffect(() => () => { if (videoPreview) URL.revokeObjectURL(videoPreview); }, [videoPreview]);
  useEffect(() => () => { streamRef.current?.getTracks().forEach(track => track.stop()); if (timerRef.current) window.clearInterval(timerRef.current); }, []);
  useEffect(() => { if (existingUser && teacher) void request<{ files: VerificationFile[] }>('teachers/verification/status').then(result => setRemoteFiles(result.files)).catch(cause => setError((cause as Error).message)); }, [existingUser, teacher]);
  const set = (key: keyof Fields, value: string | boolean) => { setFields(current => ({ ...current, [key]: value })); setError(''); };
  const handleGoogleCredential = useCallback((credential: string, profile: { email?: string; given_name?: string; family_name?: string }) => {
    setGoogleCredential(credential);
    setFields(current => ({ ...current, email: profile.email || current.email, first_name: current.first_name || profile.given_name || '', family_name: current.family_name || profile.family_name || '' }));
    setError('');
  }, []);
  const toggle = (value: string, list: string[], update: (value: string[]) => void) => update(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  function validate(current: number) {
    if (current === 0) {
      if (![fields.first_name, fields.father_name, fields.family_name].every(value => value.trim().length >= 2)) return t('أكمل الاسم الأول واسم الأب واسم العائلة.');
      if (computedAge === null || computedAge < (teacher ? 18 : 5) || computedAge > 100) return teacher ? t('يجب أن يكون عمر الأستاذ 18 سنة على الأقل.') : t('تحقق من تاريخ الميلاد.');
      if (!fields.gender) return t('اختر الجنس.'); if (!validJordanPhone(fields.phone)) return t('أدخل رقم هاتف أردني صحيح يبدأ بـ 077 أو 078 أو 079.');
    }
    if (current === 1) {
      if (!googleCredential && !/^\S+@\S+\.\S+$/.test(fields.email)) return t('أدخل بريداً إلكترونياً صحيحاً.');
      if (!googleCredential && fields.password.length < 12) return t('كلمة المرور 12 حرفاً على الأقل.');
      if (!googleCredential && fields.password !== fields.confirm_password) return t('كلمتا المرور غير متطابقتين.');
      if (!fields.accept_terms) return t('وافق على الشروط وسياسة الخصوصية للمتابعة.');
    }
    if (teacher && current === 2) {
      if (!selectedQualifications.length) return t('اختر مؤهلاً واحداً على الأقل.');
      if (selectedQualifications.includes('أخرى') && fields.other_qualification.trim().length < 2) return t('اكتب المؤهل الآخر.');
      if (!languages.length) return t('اختر لغة تدريس واحدة على الأقل.');
      if (!/^\d{4}$/.test(fields.national_id_last4)) return t('أدخل آخر 4 أرقام من الرقم الوطني.');
      if (fields.professional_bio.trim().length < 20) return t('اكتب نبذة مهنية من 20 حرفاً على الأقل.');
      if (!fields.confirm_accuracy || !fields.accept_teaching_policy) return t('أكد صحة البيانات ووافق على سياسة التدريس.');
    }
    if (teacher && current === 3) { if (!photo && !remoteFiles.some(file => file.kind === 'avatar')) return t('أضف صورة شخصية واضحة.'); if (!credentials.length && !remoteFiles.some(file => file.kind === 'credential')) return t('أضف مستنداً داعماً واحداً على الأقل.'); if (!videoFile && !remoteFiles.some(file => file.kind === 'intro_video')) return t('سجّل فيديو التحقق المباشر.'); if (videoFile && recordedSeconds < 5) return t('يجب أن يكون فيديو التحقق 5 ثوانٍ على الأقل.'); }
    return '';
  }
  async function next() { const message = validate(step); if (message) return setError(message); if (!teacher && step === 1) return submit(); setStep(value => Math.min(steps.length - 1, value + 1)); setError(''); }
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: true }); streamRef.current = stream; if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm'; const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 900000 }); recorderRef.current = recorder; chunksRef.current = []; setRecordedSeconds(0);
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => { const blob = new Blob(chunksRef.current, { type: 'video/webm' }); setVideoFile(new File([blob], 'mansah-verification.webm', { type: 'video/webm' })); stream.getTracks().forEach(track => track.stop()); streamRef.current = null; setRecording(false); if (timerRef.current) window.clearInterval(timerRef.current); };
      recorder.start(500); setRecording(true); timerRef.current = window.setInterval(() => setRecordedSeconds(value => { if (value >= 29) { recorder.stop(); return 30; } return value + 1; }), 1000);
    } catch { setError(t('تعذر تشغيل الكاميرا والميكروفون. اسمح بالوصول ثم حاول مجدداً.')); }
  }
  function stopRecording() { if (recorderRef.current?.state === 'recording') recorderRef.current.stop(); }
  async function submit() {
    const message = validate(step); if (message) return setError(message); setBusy(true); setError('');
    const payload = { ...fields, role: portal, name: fullName, qualifications: selectedQualifications, teaching_languages: languages };
    try {
      let user = createdUser;
      if (!user) { const result = await request<{ user: User }>(googleCredential ? 'auth/google' : 'auth/register', googleCredential ? { ...payload, credential: googleCredential } : payload); user = result.user; setCreatedUser(user); }
      if (teacher) {
        const uploads: Array<[string, File]> = [...(photo ? [['avatar', photo] as [string, File]] : []), ...(videoFile ? [['intro_video', videoFile] as [string, File]] : []), ...credentials.map((file, index) => [`credential-${index}`, file] as [string, File])];
        for (const [key, file] of uploads) if (!uploadedRef.current.has(key)) { await requestFile('teachers/verification/files', file, { kind: key.startsWith('credential') ? 'credential' : key }); uploadedRef.current.add(key); }
        const result = await request<{ user: User }>('teachers/verification/submit', {}); user = result.user;
      }
      onLogin(user);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <section className="registration-flow" dir={direction()}>
    <header><button type="button" className="icon-button" onClick={onCancel} title={t('العودة لتسجيل الدخول')}><X size={20} /></button><div><span>{teacher ? <BadgeCheck size={18} /> : <UserRound size={18} />}{teacher ? t('طلب اعتماد أستاذ') : t('إنشاء حساب طالب')}</span><h1>{steps[step]}</h1></div><strong>{step + 1}/{steps.length}</strong></header>
    <div className="registration-progress">{steps.map((label, index) => <span className={index < step ? 'done' : index === step ? 'current' : ''} key={label}><i>{index < step ? <Check size={14} /> : index + 1}</i><small>{label}</small></span>)}</div>
    {step === 0 && <div className="registration-stage"><div className="registration-heading"><UserRound size={25} /><div><h2>{t('بياناتك الأساسية')}</h2><p>{t('اكتب الاسم كما يظهر في وثائقك الرسمية.')}</p></div></div><div className="registration-grid three"><label>{t('الاسم الأول')}<input value={fields.first_name} onChange={event => set('first_name', event.target.value)} autoComplete="given-name" maxLength={50} /></label><label>{t('اسم الأب')}<input value={fields.father_name} onChange={event => set('father_name', event.target.value)} maxLength={50} /></label><label>{t('اسم العائلة')}<input value={fields.family_name} onChange={event => set('family_name', event.target.value)} autoComplete="family-name" maxLength={50} /></label></div><div className="registration-grid"><label>{t('تاريخ الميلاد')}<span className="birth-field"><input type="date" value={fields.birth_date} onChange={event => set('birth_date', event.target.value)} />{computedAge !== null && <b>{computedAge} {t('سنة')}</b>}</span></label><label>{t('الجنس')}<select value={fields.gender} onChange={event => set('gender', event.target.value)}><option value="">{t('اختر')}</option><option value="male">{t('ذكر')}</option><option value="female">{t('أنثى')}</option><option value="prefer_not">{t('أفضل عدم الإجابة')}</option></select></label><label className="full">{t('رقم الهاتف الأردني')}<span className="field-with-icon"><Phone size={17} /><input dir="ltr" inputMode="tel" value={fields.phone} onChange={event => set('phone', event.target.value)} placeholder="079 123 4567" autoComplete="tel" /></span><small>{t('نقبل أرقام 077 و078 و079، وسيُحفظ الرقم بصيغة دولية.')}</small></label></div></div>}
    {step === 1 && <div className="registration-stage"><div className="registration-heading"><ShieldCheck size={25} /><div><h2>{t('أمان الحساب')}</h2><p>{t('استخدم بريداً تملكه وكلمة مرور قوية.')}</p></div></div><GoogleLink onCredential={handleGoogleCredential} />{googleCredential && <p className="google-linked"><Check size={16} />{t('تم ربط حساب Google. أكمل البيانات ثم أنشئ الحساب.')}</p>}<div className="registration-divider"><span>{t('أو بالبريد الإلكتروني')}</span></div><div className="registration-grid"><label className="full">{t('البريد الإلكتروني')}<input type="email" dir="ltr" value={fields.email} disabled={Boolean(googleCredential)} onChange={event => set('email', event.target.value)} autoComplete="email" /></label>{!googleCredential && <><label>{t('كلمة المرور')}<input type="password" dir="ltr" value={fields.password} onChange={event => set('password', event.target.value)} autoComplete="new-password" minLength={12} /></label><label>{t('تأكيد كلمة المرور')}<input type="password" dir="ltr" value={fields.confirm_password} onChange={event => set('confirm_password', event.target.value)} autoComplete="new-password" minLength={12} /></label></>}</div><label className="registration-consent"><input type="checkbox" checked={fields.accept_terms} onChange={event => set('accept_terms', event.target.checked)} /><span><strong>{t('أوافق على شروط الاستخدام وسياسة الخصوصية')}</strong><small>{t('لن نشارك بيانات التحقق خارج فريق المراجعة المخوّل.')}</small></span></label></div>}
    {teacher && step === 2 && <div className="registration-stage"><div className="registration-heading"><GraduationCap size={25} /><div><h2>{t('المؤهلات والخبرة')}</h2><p>{t('هذه المعلومات تساعد الأونر على مراجعة أهليتك للتدريس.')}</p></div></div><div className="verification-options">{qualifications.map(value => <label className={selectedQualifications.includes(value) ? 'selected' : ''} key={value}><input type="checkbox" checked={selectedQualifications.includes(value)} onChange={() => toggle(value, selectedQualifications, setSelectedQualifications)} /><span><Check size={14} /></span>{t(value)}</label>)}</div>{selectedQualifications.includes('أخرى') && <label>{t('اكتب المؤهل الآخر')}<input value={fields.other_qualification} onChange={event => set('other_qualification', event.target.value)} maxLength={120} /></label>}<div className="registration-grid"><label>{t('سنوات الخبرة')}<input type="number" min="0" max="60" value={fields.years_experience} onChange={event => set('years_experience', event.target.value)} /></label><label>{t('آخر 4 أرقام من الرقم الوطني')}<input dir="ltr" inputMode="numeric" maxLength={4} value={fields.national_id_last4} onChange={event => set('national_id_last4', event.target.value.replace(/\D/g, ''))} /><small>{t('لا نخزن الرقم الوطني كاملًا حفاظاً على الخصوصية.')}</small></label></div><fieldset><legend>{t('لغات التدريس')}</legend><div className="verification-options compact">{teachingLanguages.map(value => <label className={languages.includes(value) ? 'selected' : ''} key={value}><input type="checkbox" checked={languages.includes(value)} onChange={() => toggle(value, languages, setLanguages)} /><span><Check size={14} /></span>{t(value)}</label>)}</div></fieldset><label>{t('نبذة مهنية')}<textarea value={fields.professional_bio} onChange={event => set('professional_bio', event.target.value)} maxLength={800} rows={4} placeholder={t('اذكر تخصصك وخبرتك والفئات التي تفضّل تدريسها…')} /></label><label className="registration-consent"><input type="checkbox" checked={fields.confirm_accuracy} onChange={event => set('confirm_accuracy', event.target.checked)} /><span>{t('أؤكد أن جميع البيانات والمستندات صحيحة.')}</span></label><label className="registration-consent"><input type="checkbox" checked={fields.accept_teaching_policy} onChange={event => set('accept_teaching_policy', event.target.checked)} /><span>{t('أوافق على سياسة سلوك وأمان المعلّمين.')}</span></label></div>}
    {teacher && step === 3 && <div className="registration-stage media-verification"><div className="registration-heading"><Video size={25} /><div><h2>{t('التحقق المرئي والمستندات')}</h2><p>{t('لا يمكن إرسال الطلب قبل إكمال العناصر الثلاثة.')}</p></div></div><div className="verification-upload-grid"><label className="photo-uploader">{photoPreview ? <img src={photoPreview} alt={t('معاينة الصورة الشخصية')} /> : <Camera size={30} />}<strong>{photo ? photo.name : t('صورة شخصية واضحة')}</strong><small>{t('JPG أو PNG أو WebP — حتى 5MB')}</small><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0] || null; if (file && file.size > 5 * 1024 * 1024) setError(t('الصورة أكبر من 5 ميغابايت.')); else setPhoto(file); }} /></label><label className="document-uploader"><Upload size={30} /><strong>{credentials.length ? t('{v0} مستندات مختارة', { v0: credentials.length }) : t('الشهادات والمستندات الداعمة')}</strong><small>{t('PDF أو صورة — حتى 5 ملفات، 10MB للملف')}</small><input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={event => setCredentials(Array.from(event.target.files || []).slice(0, 5))} /></label></div>{credentials.length > 0 && <div className="credential-list">{credentials.map(file => <span key={`${file.name}-${file.size}`}><FileCheck2 size={15} />{file.name}</span>)}</div>}<div className="live-verification"><div><strong>{t('الجملة المطلوبة داخل الفيديو')}</strong><p>“{phrase}”</p><small>{t('سجّل من 5 إلى 30 ثانية. التسجيل المباشر يمنع استخدام فيديو قديم.')}</small></div><video ref={videoRef} muted playsInline controls={Boolean(videoFile)} src={videoPreview || undefined} /><div className="record-actions">{!recording ? <button className="secondary-button" type="button" onClick={() => void startRecording()}><Camera size={18} />{videoFile ? t('إعادة التسجيل') : t('تشغيل الكاميرا وبدء التسجيل')}</button> : <button className="record-stop" type="button" onClick={stopRecording}><i />{t('إيقاف التسجيل')} <b>{recordedSeconds}s</b></button>}{videoFile && !recording && <span><Check size={16} />{t('فيديو التحقق جاهز')}</span>}</div></div></div>}
    {error && <p className="notice error registration-error" role="alert">{t(error)}</p>}
    <footer className="registration-actions">{step > 0 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => { setStep(value => value - 1); setError(''); }}><ArrowRight size={18} />{t('السابق')}</button> : <button type="button" className="text-button" onClick={onCancel}>{t('لدي حساب بالفعل')}</button>}<button type="button" className="primary-button" disabled={busy || recording} onClick={() => void (step === steps.length - 1 ? submit() : next())}>{busy ? <LoaderCircle className="spin" size={18} /> : step === steps.length - 1 ? <ShieldCheck size={18} /> : <ArrowLeft size={18} />}{busy ? t('جارٍ رفع طلبك بأمان…') : step === steps.length - 1 ? teacher ? t('إرسال طلب الاعتماد') : t('إنشاء حساب الطالب') : t('التالي')}</button></footer>
  </section>;
}
