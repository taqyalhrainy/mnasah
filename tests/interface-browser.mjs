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
  { id: 'math-slot', teacher_id: teacher.id, teacher_name: teacher.name, teacher_subjects: teacher.subject, subject: 'رياضيات', minutes: 60, price: 1500, start: now + 3600000, available_until: now + 10800000, status: 'open', bio: '' },
  { id: 'physics-slot', teacher_id: 'teacher-two', teacher_name: 'ليان الزعبي', teacher_subjects: 'فيزياء', subject: 'فيزياء', minutes: 45, price: 1200, start: now + 7200000, available_until: now + 14400000, status: 'open', bio: '' },
];
const bookings = [
  { ...slots[0], id: 'booking-ui', slot_id: slots[0].id, student_id: student.id, student_name: student.name, notes: 'مراجعة المعادلات', resource: '', status: 'confirmed', paid: 1, payment_ref: 'test', teacher_present_until: now + 60000, student_present_until: 0 },
  { ...slots[1], id: 'booking-completed', slot_id: slots[1].id, student_id: student.id, student_name: student.name, notes: '', resource: '', start: now - 86400000, status: 'completed', paid: 1, payment_ref: 'test' },
];
const errors = [];
const mutations = [];

async function makePage(role, loggedIn = true) {
  const user = role === 'students' ? student : role === 'teachers' ? teacher : owner;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', permissions: ['notifications'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') mutations.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: loggedIn ? user : null } });
    if (/\/auth\/(login|register)$/.test(path)) return route.fulfill({ json: { user } });
    if (path.endsWith('/reminders')) return route.fulfill({ json: { bookings: [] } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/payments')) return route.fulfill({ json: paymentSummary(bookings, paymentRange(Object.fromEntries(new URL(request.url()).searchParams))) });
    if (path.endsWith('/messages')) return route.fulfill({ json: { messages: [{ id: 'message-ui', name: teacher.name, body: 'أهلاً، جاهزين للحصة.', created: now }] } });
    return route.fulfill({ json: { user, bookings, slots, users: [teacher, student], events: [{ id: 'audit-ui', name: owner.name, action: 'user:active', target: teacher.id, created: now }] } });
  });
  await page.goto(`${base}/${role}`);
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
    for (const element of document.querySelectorAll('.category-card, .primary-button, .secondary-button, .nav-button, .overview-metric, .auth-role-tabs a')) {
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
      if (name === 'الغرف' || name === 'المتاحة' || name === 'الحسابات') {
        await page.screenshot({ path: `.private/redesign-${role}-${name === 'الغرف' ? 'rooms' : name === 'المتاحة' ? 'availability' : 'accounts'}-mobile.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await checkLayout(page, `${role} ${name} desktop`);
        await page.screenshot({ path: `.private/redesign-${role}-${name === 'الغرف' ? 'rooms' : name === 'المتاحة' ? 'availability' : 'accounts'}-desktop.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
      }
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
      assert.ok(mutations.some(item => item.path.endsWith('/students/slots/math-slot')));
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
      await checkLayout(page, 'teacher availability settings mobile');
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 760 });
      await page.waitForFunction(() => document.querySelector('.availability-showcase')?.getBoundingClientRect().bottom <= window.innerHeight);
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-short-desktop.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await checkLayout(page, 'teacher availability settings desktop');
      await page.screenshot({ path: '.private/redesign-teachers-availability-settings-desktop.png', fullPage: true });
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
  await page.getByLabel('البريد الإلكتروني').fill('student@example.test');
  await page.getByLabel('كلمة المرور', { exact: true }).fill('Ui-testing-password-123');
  await page.getByLabel('تأكيد كلمة المرور', { exact: true }).fill('Ui-testing-password-123');
  await page.getByRole('checkbox', { name: /أوافق على شروط الاستخدام/ }).check();
  await page.getByRole('button', { name: 'إنشاء حساب الطالب', exact: true }).click();
  await page.locator('.workspace-content').waitFor();
  assert.ok(mutations.some(item => item.path.endsWith('/auth/register') && item.body.role === 'students'));
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Interface checks passed: all three portals, 320-1920px, discovery, booking, lesson details, history filters, password visibility and registration.');
} finally {
  await browser.close();
}
