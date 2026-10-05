import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { paymentRange, paymentSummary } from '../shared/payments.js';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const now = Date.now(), current = paymentRange({});
const users = { admin: { id: 'owner', name: 'مدير المنصّة', role: 'admin', status: 'active', email: 'owner@example.test', subject: '', bio: '' }, teachers: { id: 'teacher', name: 'أحمد الخطيب', role: 'teachers', status: 'active', email: 'teacher@example.test', subject: 'المنهاج الأردني › رياضيات › الصف العاشر', bio: '' }, students: { id: 'student', name: 'سارة أحمد', role: 'students', status: 'active', email: 'student@example.test', subject: '', bio: '' } };
const categories = [{ id: 'jordan', name: 'المنهاج الأردني', description: 'توجيهي وجميع الصفوف المدرسية', icon: '📚', levels: ['الصف العاشر'], subjects: ['رياضيات', 'فيزياء'] }, { id: 'quran', name: 'تحفيظ القرآن الكريم', description: 'تلاوة، حفظ، وتجويد', icon: '☘', levels: [], subjects: ['حفظ', 'تجويد'] }];
const row = { slot_id: 'slot', teacher_id: 'teacher', teacher_name: users.teachers.name, student_id: 'student', student_name: users.students.name, subject: 'رياضيات', minutes: 60, start: current.from, status: 'completed', paid: 1, payment_ref: 'receipt', price: 1500, notes: '', resource: '' };
const bookings = [{ ...row, id: 'one' }, { ...row, id: 'two', teacher_id: 'other', teacher_name: 'ليان الزعبي', price: 1200, paid: 0, minutes: 30 }, { ...row, id: 'cancelled', status: 'cancelled', price: 99000 }, { ...row, id: 'upcoming', status: 'confirmed', start: now + 7200000 }];
const slots = [{ ...row, id: 'slot', start: now + 7200000, available_until: now + 10800000, status: 'open', teacher_subjects: users.teachers.subject }];
const failures = [];
await mkdir('.private', { recursive: true });
async function layout(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const issues = await page.evaluate(() => {
    const result = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) result.push(`Page overflow: ${document.documentElement.scrollWidth}`);
    for (const node of document.querySelectorAll('.nav-button,.language-control,.primary-button,.secondary-button,.payment-summary-card,.payment-breakdown dd,.payment-calendar-dialog,.payment-calendar-grid button')) {
      const bounds = node.getBoundingClientRect(); if (!bounds.width || !bounds.height) continue;
      if (node.scrollWidth > node.clientWidth + 2) result.push(`Text overflow: ${node.className} ${node.textContent}`);
      if (bounds.left < -1 || bounds.right > innerWidth + 1) result.push(`Viewport overflow: ${node.className}`);
    }
    return result;
  });
  if (issues.length) await page.screenshot({ path: '.private/preferences-failure.png', fullPage: true });
  assert.deepEqual(issues, [], name);
}
async function makePage(role, loggedIn = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Asia/Amman', colorScheme: 'light' });
  const page = await context.newPage(), mutations = [], ranges = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (route.request().method() === 'POST') mutations.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: loggedIn ? users[role] : null } });
    if (path.endsWith('/auth/login')) return route.fulfill({ status: 401, json: { error: 'بيانات الدخول غير صحيحة لهذا القسم.' } });
    if (path.endsWith('/payments')) { const range = paymentRange(Object.fromEntries(url.searchParams)); ranges.push(range); return route.fulfill({ json: paymentSummary(role === 'teachers' ? bookings.filter(row => row.teacher_id === users.teachers.id) : bookings, range) }); }
    if (path.endsWith('/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/reminders')) return route.fulfill({ json: { bookings: [] } });
    if (path.includes('/chat/')) return route.fulfill({ json: { threads: [], settings: { readReceipts: true, showPresence: true, notifications: false, sounds: false }, unread: 0, messages: [] } });
    return route.fulfill({ json: { user: users[role], bookings: role === 'teachers' ? bookings.filter(row => row.teacher_id === users.teachers.id) : bookings, slots, users: Object.values(users), events: [] } });
  });
  await page.goto(`${base}/${role}`);
  await page.locator(loggedIn ? '.workspace-content' : '.auth-form').waitFor();
  return { page, context, mutations, ranges };
}
try {
  for (const role of ['admin', 'teachers', 'students']) {
    const { page, context, mutations } = await makePage(role);
    for (const language of ['en', 'ar']) {
      await page.locator('.language-control select').selectOption(language);
      assert.equal(await page.locator('html').getAttribute('lang'), language);
      assert.equal(await page.locator('html').getAttribute('dir'), language === 'ar' ? 'rtl' : 'ltr');
      for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-control').click();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        for (const width of [1440, 1024, 768, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `${role} ${language} ${theme} ${width}`); }
        const navigation = await page.locator('.nav-list button').count();
        for (let index = 0; index < navigation; index++) {
          await page.locator('.nav-list button').nth(index).click();
          await page.locator('.workspace-skeleton,.payment-loading').waitFor({ state: 'detached' });
          await layout(page, `${role} ${language} ${theme} view ${index}`);
        }
      }
    }
    if (role === 'teachers') {
      await page.locator('.language-control select').selectOption('en');
      await page.locator('.nav-list').getByRole('button', { name: 'Available', exact: true }).click();
      await page.locator('select[name=subject]').selectOption('رياضيات');
      assert.equal(await page.locator('select[name=subject]').inputValue(), 'رياضيات', 'Translated labels must not change submitted subject IDs');
    }
    assert.equal(mutations.some(row => /profile|slots/.test(row.path)), false, 'Appearance changes must never write user records');
    await page.reload(); await page.locator('.workspace-content').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('html').getAttribute('lang'), role === 'teachers' ? 'en' : 'ar');
    await context.close();
  }
  for (const role of ['admin', 'teachers']) {
    const { page, context, ranges } = await makePage(role);
    await page.getByRole('button', { name: 'المستحقات', exact: true }).click(); await page.locator('.payment-summary-card').waitFor();
    assert.equal(await page.locator('.payment-summary-card .payment-amount').textContent(), new Intl.NumberFormat('ar-JO', { style: 'currency', currency: 'JOD' }).format((role === 'admin' ? 2700 : 1275) / 100));
    await page.screenshot({ path: `.private/payments-${role}-ar-light-1440.png`, fullPage: true });
    await page.locator('.payment-summary-card').click(); await page.locator('.payment-breakdown').waitFor();
    if (role === 'admin') { await page.getByLabel('فلترة حسب الأستاذ').selectOption('teacher'); assert.equal(await page.locator('.payment-total .payment-amount').textContent(), new Intl.NumberFormat('ar-JO', { style: 'currency', currency: 'JOD' }).format(15)); await page.getByLabel('فلترة حسب الأستاذ').selectOption('all'); }
    await page.locator('.payment-lessons-toggle').click(); assert.equal(await page.locator('.payment-lesson-row').count(), role === 'admin' ? 2 : 1);
    const download = page.waitForEvent('download'); await page.getByTitle('تنزيل التقرير CSV').click(); const file = await download; assert.match(file.suggestedFilename(), /mansah-payments-.*\.csv/); const csv = await readFile(await file.path(), 'utf8'); assert.match(csv, /رياضيات/); assert.doesNotMatch(csv, /cancelled|990\.000/);
    await page.locator('.language-control select').selectOption('en'); await page.locator('.theme-control').click();
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `Payments details ${role} ${width}`); if (width !== 320) await page.screenshot({ path: `.private/payments-${role}-en-dark-${width}.png`, fullPage: true }); }
    await page.getByTitle('Select dates').click(); await page.locator('.payment-calendar-dialog').waitFor();
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `Calendar ${role} ${width}`); }
    await page.screenshot({ path: `.private/payments-calendar-${role}-en-dark.png`, fullPage: true });
    assert.ok(await page.locator('.payment-calendar-grid button:disabled').count(), 'Future days are unavailable');
    const recent = new Date(`${current.end}T12:00:00Z`); recent.setUTCDate(recent.getUTCDate() - 35);
    const monthLabel = value => new Intl.DateTimeFormat('en-JO', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(value);
    const dayLabel = value => new Intl.DateTimeFormat('en-JO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(value);
    while (await page.locator('.calendar-month-toolbar strong').textContent() !== monthLabel(recent)) await page.getByTitle('Previous month').click();
    await page.locator('.payment-calendar-grid').getByRole('button', { name: dayLabel(recent), exact: true }).click();
    const today = new Date(`${current.end}T12:00:00Z`);
    while (await page.locator('.calendar-month-toolbar strong').textContent() !== monthLabel(today)) await page.getByTitle('Next month').click();
    await page.locator('.payment-calendar-grid').getByRole('button', { name: dayLabel(today), exact: true }).click();
    assert.equal(await page.locator('.payment-calendar-dialog').getByRole('alert').textContent(), 'Select one day or a range of up to 31 days.');
    await page.locator('.payment-calendar-dialog').getByRole('button', { name: 'Today', exact: true }).click(); await page.getByRole('button', { name: 'Apply dates', exact: true }).click(); await page.locator('.payment-loading').waitFor({ state: 'detached' }); assert.equal(ranges.at(-1).start, ranges.at(-1).end);
    await page.getByTitle('Previous week').click(); await page.locator('.payment-loading').waitFor({ state: 'detached' }); assert.equal(await page.locator('.payment-lessons-toggle').count(), 0); assert.equal(await page.locator('.payment-total .payment-amount').textContent(), new Intl.NumberFormat('en-JO', { style: 'currency', currency: 'JOD' }).format(0));
    await context.close();
  }
  for (const role of ['students', 'teachers', 'admin']) {
    const { page, context } = await makePage(role, false);
    await page.locator('.language-control select').selectOption('en'); await page.locator('.theme-control').click();
    assert.equal(await page.locator('.auth-form h1').textContent(), 'Sign in');
    await page.locator('input[name=email]').fill('test@example.test'); await page.locator('input[name=password]').fill('not-a-real-password'); await page.locator('.auth-submit').click(); assert.equal(await page.getByRole('alert').textContent(), 'Incorrect sign-in details for this portal.');
    for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); await layout(page, `${role} English dark sign in ${width}`); }
    await page.reload(); await page.locator('.auth-form').waitFor(); assert.equal(await page.locator('html').getAttribute('lang'), 'en'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.screenshot({ path: `.private/auth-${role}-en-dark.png`, fullPage: true }); await context.close();
  }
  assert.deepEqual(failures, []);
  console.log('Preferences and payments passed: every portal/view, Arabic/English, light/dark, 320-1440px, persistence, protected data values, actual totals, filters, CSV, calendar, previous periods and translated errors.');
} finally { await browser.close(); }
