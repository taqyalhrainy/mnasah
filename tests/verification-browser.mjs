import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const uploads = []; const posts = [];
const verification = { first_name: 'أحمد', father_name: 'محمد', family_name: 'الخطيب', birth_date: '1990-01-10', age: 36, gender: 'male', phone: '+962791234567', qualifications: ['بكالوريوس'], years_experience: 5, teaching_languages: ['العربية'], national_id_last4: '1234', professional_bio: 'أستاذ رياضيات بخبرة في تدريس مختلف المراحل.', verification_status: 'incomplete' };
const pending = { id: 'new-teacher', name: 'أحمد محمد الخطيب', email: 'teacher-new@example.test', role: 'teachers', status: 'pending', subject: '', bio: verification.professional_bio, verification };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'], serviceWorkers: 'block' });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: null } });
    if (url.pathname.endsWith('/auth/register')) { posts.push(request.postDataJSON()); return route.fulfill({ json: { user: pending } }); }
    if (url.pathname.endsWith('/verification/files')) { uploads.push({ kind: url.searchParams.get('kind'), size: Number(url.searchParams.get('size')), body: (await request.postDataBuffer())?.length || 0 }); return route.fulfill({ json: { file: { id: crypto.randomUUID(), kind: url.searchParams.get('kind') } } }); }
    if (url.pathname.endsWith('/verification/submit')) return route.fulfill({ json: { user: { ...pending, verification: { ...verification, verification_status: 'submitted', submitted_at: Date.now() } } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/teachers`); await page.getByRole('button', { name: 'إنشاء حساب جديد', exact: true }).click();
  await page.getByLabel('الاسم الأول').fill('أحمد'); await page.getByLabel('اسم الأب').fill('محمد'); await page.getByLabel('اسم العائلة').fill('الخطيب');
  await page.getByLabel('تاريخ الميلاد').fill('1990-01-10'); await page.getByLabel('الجنس').selectOption('male'); await page.getByLabel('رقم الهاتف الأردني').fill('0791234567');
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  await page.getByLabel('البريد الإلكتروني').fill(pending.email); await page.getByLabel('كلمة المرور', { exact: true }).fill('Strong-test-password-123'); await page.getByLabel('تأكيد كلمة المرور').fill('Strong-test-password-123'); await page.getByRole('checkbox', { name: /أوافق على شروط الاستخدام/ }).check();
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  await page.locator('.verification-options label').filter({ hasText: 'بكالوريوس' }).click(); await page.getByLabel('سنوات الخبرة').fill('5'); await page.getByLabel('آخر 4 أرقام من الرقم الوطني').fill('1234'); await page.getByLabel('نبذة مهنية').fill(verification.professional_bio);
  await page.getByRole('checkbox', { name: /أؤكد أن جميع البيانات/ }).check(); await page.getByRole('checkbox', { name: /أوافق على سياسة سلوك/ }).check(); await page.getByRole('button', { name: 'التالي', exact: true }).click();
  await page.locator('.photo-uploader input').setInputFiles({ name: 'profile.png', mimeType: 'image/png', buffer: Buffer.from([137,80,78,71,13,10,26,10,0]) });
  await page.locator('.document-uploader input').setInputFiles({ name: 'degree.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
  await page.getByRole('button', { name: 'تشغيل الكاميرا وبدء التسجيل', exact: true }).click(); await page.getByRole('button', { name: /إيقاف التسجيل/ }).waitFor(); await page.waitForTimeout(5200); await page.getByRole('button', { name: /إيقاف التسجيل/ }).click(); await page.getByText('فيديو التحقق جاهز', { exact: true }).waitFor();
  await page.screenshot({ path: '.private/teacher-verification-final.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '.private/teacher-verification-mobile.png', fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Teacher verification must not overflow on mobile');
  await page.getByRole('button', { name: 'إرسال طلب الاعتماد', exact: true }).click(); await page.getByText('طلبك قيد المراجعة', { exact: true }).waitFor();
  assert.equal(posts.length, 1); assert.equal(posts[0].phone, '0791234567'); assert.deepEqual(posts[0].qualifications, ['بكالوريوس']); assert.deepEqual(uploads.map(row => row.kind).sort(), ['avatar', 'credential', 'intro_video']); assert.ok(uploads.every(row => row.size === row.body)); assert.deepEqual(errors, []);
  await context.close();
  const owner = { id: 'owner', name: 'مدير المنصة', email: 'owner@example.test', role: 'admin', status: 'active', subject: '', bio: '' };
  const reviewedTeacher = { ...pending, verification: { ...verification, verification_status: 'submitted', submitted_at: Date.now() }, verification_files: [{ id: 'avatar-file', user_id: pending.id, kind: 'avatar', name: 'profile.png', size: 100, content_type: 'image/png' }, { id: 'video-file', user_id: pending.id, kind: 'intro_video', name: 'intro.webm', size: 1000, content_type: 'video/webm' }, { id: 'degree-file', user_id: pending.id, kind: 'credential', name: 'degree.pdf', size: 100, content_type: 'application/pdf' }] };
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); const admin = await adminContext.newPage();
  await admin.route('**/api/**', async route => { const url = new URL(route.request().url()); if (url.pathname.includes('/verification/files/avatar-file')) return route.fulfill({ body: Buffer.from([137,80,78,71,13,10,26,10,0]), contentType: 'image/png' }); if (url.pathname.includes('/verification/files/video-file')) return route.fulfill({ body: Buffer.from([0x1a,0x45,0xdf,0xa3,0]), contentType: 'video/webm' }); if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: owner } }); if (url.pathname.endsWith('/admin/catalog')) return route.fulfill({ json: { categories: [] } }); if (url.pathname.endsWith('/admin/users')) return route.fulfill({ json: { users: [reviewedTeacher] } }); return route.fulfill({ json: { users: [reviewedTeacher], bookings: [], slots: [], events: [] } }); });
  await admin.goto(`${base}/admin`); await admin.locator('.workspace-content').waitFor(); await admin.getByRole('button', { name: 'الحسابات', exact: true }).click(); await admin.getByRole('button', { name: 'مراجعة التحقق', exact: true }).click(); await admin.getByRole('dialog').waitFor(); assert.match(await admin.getByRole('dialog').innerText(), /بكالوريوس/); await admin.screenshot({ path: '.private/owner-verification-review.png', fullPage: true }); await adminContext.close();
  console.log('Teacher verification browser flow passed: identity, Jordan phone, qualifications, live recording, secure uploads and pending review.');
} finally { await browser.close(); }
