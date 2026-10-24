import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { paymentRange, paymentSummary } from '../shared/payments.js';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const now = Date.now();
const categories = [
  { id: 'jordan', name: 'المنهاج الأردني', description: 'من الصفوف الأولى إلى التوجيهي', icon: '📚', levels: ['الصف الخامس', 'التوجيهي'], subjects: ['رياضيات', 'فيزياء'] },
  { id: 'quran', name: 'القرآن الكريم', description: 'حفظ وتلاوة وتجويد', icon: '☘', levels: [], subjects: ['حفظ', 'تجويد'] },
  { id: 'languages', name: 'اللغات', description: 'آفاق جديدة، وكلمات جديدة', icon: 'EN', levels: ['مبتدئ', 'متقدم'], subjects: ['الإنجليزية'] },
  { id: 'university', name: 'المواد الجامعية', description: 'معرفة أعمق لتخصصك', icon: '🎓', levels: [], subjects: ['تفاضل وتكامل'] },
  { id: 'skills', name: 'مهارات وتطوير', description: 'خطوة جديدة في مسارك', icon: '✨', levels: [], subjects: ['البرمجة'] },
  { id: 'writing', name: 'اللغة العربية', description: 'بلاغة، قواعد، وتعبير', icon: '✍', levels: [], subjects: ['النحو'] },
];
const teacher = { id: 'teacher-ui', name: 'أحمد الخطيب', email: 'teacher@example.test', role: 'teachers', status: 'active', bio: 'أستاذ رياضيات', subject: 'المنهاج الأردني › رياضيات › الصف الخامس، التوجيهي | المنهاج الأردني › فيزياء › الصف الخامس، التوجيهي' };
const student = { id: 'student-ui', name: 'سارة أحمد', email: 'student@example.test', role: 'students', status: 'active', subject: '', bio: '' };
const owner = { id: 'owner-ui', name: 'مدير المنصّة', email: 'owner@example.test', role: 'admin', status: 'active', subject: '', bio: '' };
const slots = [
  { id: 'math-slot', teacher_id: teacher.id, teacher_name: teacher.name, teacher_subjects: teacher.subject, subject: 'كل المواد المختارة', subjects: ['رياضيات', 'فيزياء'], minutes: 30, price: 900, offerings: [{ minutes: 30, price: 900 }, { minutes: 90, price: 2200 }], start: now + 3600000, available_until: now + 10800000, status: 'open', bio: '' },
  { id: 'physics-slot', teacher_id: 'teacher-two', teacher_name: 'ليان الزعبي', teacher_subjects: 'فيزياء', subject: 'فيزياء', minutes: 45, price: 1200, start: now + 7200000, available_until: now + 14400000, status: 'open', bio: '' },
];
const bookings = [
  { ...slots[0], id: 'booking-ui', slot_id: slots[0].id, student_id: student.id, student_name: student.name, notes: 'مراجعة المعادلات', resource: '', status: 'confirmed', paid: 1, payment_ref: 'test', teacher_present_until: now + 60000, student_present_until: 0 },
  { ...slots[1], id: 'booking-completed', slot_id: slots[1].id, student_id: student.id, student_name: student.name, notes: '', resource: '', start: now - 86400000, status: 'completed', paid: 1, payment_ref: 'test' },
];
const walletTopup = { id: 'receipt-ui', user_id: student.id, user_name: student.name, user_email: student.email, amount: 2500, status: 'pending', transfer_reference: 'CLIQ-2026-1001', proof_name: 'receipt.png', proof_type: 'image/png', created: now, reviewed_at: 0, rejection_reason: '' };
const errors = [];
const mutations = [];

async function makePage(role, loggedIn = true) {
  const user = role === 'students' ? student : role === 'teachers' ? teacher : owner;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', permissions: ['notifications'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'application/javascript', body: `window.google={accounts:{id:{initialize(options){window.__googleCallback=options.callback},renderButton(node){const button=document.createElement('button');button.type='button';button.textContent='المتابعة باستخدام Google';button.onclick=()=>window.__googleCallback({credential:'header.payload.signature'});node.append(button)}}}};` }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') mutations.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: loggedIn ? user : null } });
    if (/\/auth\/(login|register|google)$/.test(path)) return route.fulfill({ json: { user } });
    if (path.endsWith('/reminders')) return route.fulfill({ json: { bookings: [] } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/students/wallet')) return route.fulfill({ json: { balance: 5000, payment: { cliq_name: 'Mansah', cliq_alias: 'Mansah.CliQ', ready: true }, topups: [], transactions: [] } });
    if (path.endsWith('/admin/wallet/topups/receipt-ui/proof')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    if (path.endsWith('/admin/wallet-topups')) return route.fulfill({ json: { settings: { cliq_name: 'Mansah', cliq_alias: 'Mansah.CliQ' }, topups: [walletTopup] } });
    if (path.endsWith('/payments')) return route.fulfill({ json: paymentSummary(bookings, paymentRange(Object.fromEntries(new URL(request.url()).searchParams))) });
    if (path.endsWith('/messages')) return route.fulfill({ json: { messages: [{ id: 'message-ui', name: teacher.name, body: 'أهلاً، جاهزين للحصة.', created: now }] } });
    return route.fulfill({ json: { user, bookings, slots, users: [teacher, student], events: [{ id: 'audit-ui', name: owner.name, action: 'user:active', target: teacher.id, created: now }] } });
  });
  await page.goto(`${base}/${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator(loggedIn ? '.workspace-content' : '.auth-form').waitFor().catch(async error => {
    console.error({ role, errors, visibleText: await page.locator('body').innerText() });
    await page.screenshot({ path: `.private/interface-failure-${role}.png`, fullPage: true });
    throw error;
  });
  await page.locator('.workspace-skeleton').waitFor({ state: 'detached' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  return { context, page };
}

async function checkLayout(page, label) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const problems = await page.evaluate(() => {
    const issues = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`page width ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const element of document.querySelectorAll('.brand, .category-card, .primary-button, .secondary-button, .nav-button, .overview-metric, .auth-role-tabs a')) {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      if (bounds.left < -1 || bounds.right > innerWidth + 1) issues.push(`outside viewport: ${element.className} ${element.textContent.trim()}`);
      if (element.scrollWidth > element.clientWidth + 3) issues.push(`text overflow: ${element.className} ${element.textContent.trim()}`);
    }
    return issues;
  });
  if (problems.length) await page.screenshot({ path: '.private/interface-layout-failure.png', fullPage: true });
  assert.deepEqual(problems, [], label);
}

try {
  for (const role of ['students', 'teachers', 'admin']) {
    const { context, page } = await makePage(role);
    await checkLayout(page, `${role} initial desktop`);
    assert.equal(await page.locator('.sidebar').evaluate(header => header.getBoundingClientRect().height < 100), true, `${role} desktop navigation must be a horizontal masthead`);
    for (const width of [1440, 1920, 1280, 1024, 950, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
      await checkLayout(page, `${role} home at ${width}px`);
      if (width === 1440 || width === 390) await page.screenshot({ path: `.private/redesign-${role}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const navIds = await page.locator('.nav-list .nav-button').evaluateAll(buttons => buttons.map(button => button.getAttribute('title')).filter(Boolean));
    for (const name of navIds) {
      await page.locator('.nav-list').getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await page.locator('.workspace-skeleton').waitFor({ state: 'detached' });
      await checkLayout(page, `${role} ${name} mobile`);
      if (['الغرف', 'المتاحة', 'الحسابات', 'المحفظة', 'شحن المحافظ'].includes(name)) {
        const screen = name === 'الغرف' ? 'rooms' : name === 'المتاحة' ? 'availability' : name === 'الحسابات' ? 'accounts' : name === 'المحفظة' ? 'wallet' : 'topups';
        await page.screenshot({ path: `.private/redesign-${role}-${screen}-mobile.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await checkLayout(page, `${role} ${name} desktop`);
        await page.screenshot({ path: `.private/redesign-${role}-${screen}-desktop.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
      }
    }
    if (role === 'students' || role === 'admin') {
      const target = role === 'students' ? 'المحفظة' : 'شحن المحافظ';
      const screen = role === 'students' ? 'wallet' : 'topups';
      await page.locator('.nav-list').getByRole('button', { name: target, exact: true }).click();
      await checkLayout(page, `${role} ${target} mobile`);
      await page.screenshot({ path: `.private/redesign-${role}-${screen}-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await checkLayout(page, `${role} ${target} desktop`);
      await page.screenshot({ path: `.private/redesign-${role}-${screen}-desktop.png`, fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await checkLayout(page, `${role} ${target} dark desktop`);
      await page.screenshot({ path: `.private/redesign-${role}-${screen}-dark-desktop.png`, fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    if (role === 'students') {
      await page.locator('.mobile-account > summary:visible').click();
      await page.locator('.mobile-account').getByRole('button', { name: 'حسابي', exact: true }).click();
      const reminders = page.getByRole('checkbox', { name: 'تنبيهات الحصص', exact: true });
      assert.equal(await reminders.isChecked(), false);
      await reminders.click();
      await page.waitForFunction(() => document.querySelector('.preference-toggle input')?.checked);
      await reminders.uncheck();
      assert.equal(await reminders.isChecked(), false);
      await page.locator('.nav-list').getByRole('button', { name: 'الرئيسية', exact: true }).click();
      assert.equal(await page.locator('.tutor-card').first().getByText('السعر حسب طول الحصة', { exact: true }).count(), 1);
      assert.equal(await page.getByText('ابتداءً من', { exact: true }).count(), 0);
      assert.equal(await page.locator('.tutor-card').nth(1).getByText('سعر الحصة', { exact: true }).count(), 1);
      await page.locator('.student-search input').focus();
      await page.waitForFunction(() => document.activeElement?.matches('.student-search input'));
      await page.getByTitle('عرض ملخّص الأسبوع').click();
      assert.equal(await page.locator('.agenda-days').isVisible(), true);
      await page.getByTitle('طي ملخّص الأسبوع').click();
      assert.equal(await page.locator('.agenda-days').isVisible(), false);
      await page.locator('.student-package-grid .package-card').filter({ hasText: 'المنهاج الأردني' }).click();
      await page.locator('.choice-grid').getByRole('button', { name: 'الصف الخامس' }).click();
      await page.locator('.choice-grid').getByRole('button', { name: 'رياضيات' }).click();
      assert.equal(await page.locator('.student-flow .tutor-card').count(), 1);
      page.on('dialog', dialog => dialog.accept());
      await page.locator('.student-flow').getByRole('button', { name: 'احجز الآن' }).click();
      const choiceDialog = page.getByRole('dialog');
      await choiceDialog.waitFor();
      await checkLayout(page, 'student booking choices mobile');
      await page.screenshot({ path: '.private/student-booking-choices-mobile.png', fullPage: true });
      assert.equal(await choiceDialog.getByText('أي مادة تريد أن تدرس؟', { exact: true }).count(), 0, 'the selected subject filter should skip the subject question');
      await choiceDialog.getByText('90 دقيقة', { exact: true }).click();
      await choiceDialog.getByRole('button', { name: 'تأكيد الحجز', exact: true }).click();
      for (let attempt = 0; attempt < 40 && !mutations.some(item => item.path.endsWith('/students/slots/math-slot')); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(mutations.some(item => item.path.endsWith('/students/slots/math-slot') && item.body.subject === 'رياضيات' && item.body.minutes === 90));
      await page.locator('.nav-list').getByRole('button', { name: 'السجل', exact: true }).click();
      await page.locator('.history-tabs').getByRole('button', { name: 'المكتملة', exact: true }).click();
      assert.equal(await page.locator('.history-list article').count(), 1);
      await page.getByRole('button', { name: 'التفاصيل', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await checkLayout(page, 'student lesson dialog mobile');
      await page.getByTitle('إغلاق التفاصيل').click();
    }
    if (role === 'teachers') {
      assert.equal(await page.locator('.nav-list').getByRole('button', { name: 'المحجوزة', exact: true }).count(), 0, 'booked must be merged into availability');
      await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
      await page.locator('.availability-hub').waitFor();
      assert.equal(await page.locator('.availability-day-strip button').first().getAttribute('aria-pressed'), 'true');
      await page.locator('.availability-inline-settings').waitFor();
      await page.getByRole('button', { name: 'نشر المواعيد', exact: true }).click();
      await page.getByText('اختر مادة واحدة على الأقل أولاً.', { exact: true }).waitFor();
      await page.locator('.availability-subject-menu .all-subjects').click();
      await page.getByRole('button', { name: 'تم', exact: true }).click();
      assert.match(await page.locator('.availability-subject-trigger').innerText(), /كل المواد/);
      await page.locator('.availability-day-strip button').nth(1).click();
      await page.locator('.availability-inline-settings').waitFor();
      const fromTime = page.locator('.schedule-row select').nth(0);
      const toTime = page.locator('.schedule-row select').nth(1);
      await toTime.selectOption('02:00');
      await fromTime.selectOption('23:00');
      assert.equal(await toTime.inputValue(), '02:00', 'an end time after midnight must remain selected');
      assert.equal(await toTime.locator('option[value="02:00"]').evaluate(option => option.disabled), false, 'next-day end times must stay available');
      assert.equal(await page.locator('.next-day-note').innerText(), 'اليوم التالي');
      await fromTime.selectOption('19:00');
      await toTime.selectOption('21:00');
      await checkLayout(page, 'teacher availability settings mobile');
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 760 });
      await page.waitForFunction(() => document.querySelector('.availability-showcase')?.getBoundingClientRect().bottom <= window.innerHeight);
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-short-desktop.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await checkLayout(page, 'teacher availability settings desktop');
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-desktop.png', fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await checkLayout(page, 'teacher availability settings dark desktop');
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-dark-desktop.png', fullPage: true });
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.getByRole('button', { name: 'نشر المواعيد', exact: true }).click();
      await page.locator('.availability-tabs [aria-selected=true]').filter({ hasText: 'جدولي والمحجوز' }).waitFor({ timeout: 3000 });
      assert.equal(mutations.filter(item => item.path.endsWith('/teachers/slots') && item.body.subject === 'كل المواد المختارة').length, 1);
      await page.locator('.month-grid button.today').click();
      await page.locator('.day-event.booked').first().click();
      await page.getByRole('dialog').waitFor();
      await page.getByTitle('إغلاق التفاصيل').click();
    }
    if (role === 'admin') {
      await page.getByTitle('إدارة الحسابات').click();
      await page.locator('.accounts-panel').waitFor();
    }
    await context.close();
  }
  const { context, page } = await makePage('students', false);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await checkLayout(page, `auth at ${width}px`);
    if (width === 1440 || width === 390) await page.screenshot({ path: `.private/redesign-auth-${width}.png`, fullPage: true });
  }
  await page.getByLabel('كلمة المرور', { exact: true }).fill('Ui-testing-password-123');
  await page.getByRole('button', { name: 'إظهار كلمة المرور', exact: true }).click();
  assert.equal(await page.getByLabel('كلمة المرور', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'إنشاء حساب جديد', exact: true }).click();
  await page.getByLabel('الاسم الأول').fill('سارة');
  await page.getByLabel('اسم الأب').fill('أحمد');
  await page.getByLabel('اسم العائلة').fill('الخطيب');
  await page.getByLabel('تاريخ الميلاد').fill('2000-05-20');
  await page.getByLabel('الجنس').selectOption('female');
  await page.getByLabel('رقم الهاتف الأردني').fill('0791234567');
  await page.getByRole('button', { name: 'التالي', exact: true }).click();
  assert.equal(await page.getByLabel('البريد الإلكتروني').count(), 0, 'first-time registration must not expose email/password fields');
  await page.getByRole('button', { name: 'المتابعة باستخدام Google', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: /أوافق على شروط الاستخدام/ }).check();
  await page.getByRole('button', { name: 'إنشاء حساب الطالب', exact: true }).click();
  await page.getByText('سجّل باستخدام حساب Google للمتابعة.', { exact: true }).waitFor();
  assert.ok(!mutations.some(item => item.path.endsWith('/auth/register')));
  await context.close();
  const googleLoginPage = await makePage('students', false);
  await googleLoginPage.page.getByRole('button', { name: 'المتابعة باستخدام Google', exact: true }).click();
  await googleLoginPage.page.locator('.workspace-content').waitFor();
  const googleLoginMutation = mutations.findLast(item => item.path.endsWith('/auth/google'));
  assert.equal(googleLoginMutation?.body.loginOnly, true, 'regular Google sign-in must only open an existing account');
  await googleLoginPage.context.close();
  assert.deepEqual(errors, []);
  console.log('Interface checks passed: all three portals, 320-1920px, discovery, booking, lesson details, history filters, password visibility and registration.');
} finally {
  await browser.close();
}
