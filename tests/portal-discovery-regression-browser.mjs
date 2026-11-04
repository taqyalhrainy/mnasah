import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
const dir = '.private/portal-updates';
await mkdir(dir, { recursive: true });
const categories = [{ id: 'jordan-basic', parentId: 'curriculum-jordan', name: 'المنهاج الأردني | الأساسي', description: 'المرحلة الأساسية', icon: '📚', levels: ['الصف الأول', 'الصف الثاني'], subjects: ['الرياضيات'], levelSubjects: { 'الصف الأول': ['الرياضيات'], 'الصف الثاني': ['الرياضيات'] } }, { id: 'reading', parentId: 'curriculum-jordan', name: 'تعليم القراءة والكتابة', description: '', icon: '📚', levels: [], subjects: ['تعليم القراءة والكتابة'] }];
const groups = [{ id: 'curriculum-jordan', name: 'المنهاج الأردني', icon: '🇯🇴', description: 'المناهج المدرسية' }];
const saved = 'المنهاج الأردني | الأساسي › الرياضيات › الصف الثاني';

try {
  for (const theme of ['light', 'dark']) for (const portal of ['teachers', 'students']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(theme => { localStorage.setItem('mansah-theme', theme); document.documentElement.dataset.theme = theme; }, theme);
    let user = { id: portal, role: portal, status: 'active', name: 'أحمد خالد', email: `${portal}@test.com`, bio: '', subject: portal === 'teachers' ? saved : '' };
    let profileWrites = 0;
    const now = Date.now();
    const slots = [10, 40].map((minutes, index) => ({ id: `slot-${index}`, teacher_id: `teacher-${index}`, teacher_name: index ? 'أستاذ لاحق' : 'أستاذ قريب', teacher_subjects: saved, subjects: ['الرياضيات'], subject: 'الرياضيات', start: now + minutes * 60000, available_until: now + 180 * 60000, minutes: 60, price: 1000, status: 'open' }));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
      if (path.endsWith('/catalog')) return route.fulfill({ json: { groups, categories } });
      if (path.endsWith('/profile') && route.request().method() === 'POST') { profileWrites++; user = { ...user, ...route.request().postDataJSON() }; return route.fulfill({ json: { user } }); }
      if (path.endsWith('/slots') || path.endsWith('/home')) return route.fulfill({ json: { slots, bookings: [] } });
      return route.fulfill({ json: { bookings: [] } });
    });
    await page.goto(`${base}/${portal}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const root = page.locator('.package-grid .package-card').filter({ hasText: 'المنهاج الأردني' });
    await root.waitFor();
    if (portal === 'teachers') {
      await page.locator('.teacher-saved-subjects').getByText('الرياضيات', { exact: true }).waitFor();
      assert.equal(await page.locator('.overview-metrics').count(), 0);
      assert.match(await root.getAttribute('class'), /chosen/);
      await root.click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الأساسي' }).click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الرياضيات' }).click();
      assert.equal(await page.getByLabel('الصف الثاني', { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('الصف الأول', { exact: true }).isChecked(), false);
      await page.getByLabel('الصف الأول', { exact: true }).check();
      await page.getByRole('button', { name: 'مواد المجال', exact: true }).click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الرياضيات' }).click();
      assert.equal(await page.getByLabel('الصف الأول', { exact: true }).isChecked(), false, 'back without Save must discard draft');
      await page.getByLabel('الصف الأول', { exact: true }).check();
      await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
      await page.locator('.nav-list').getByRole('button', { name: 'الرئيسية', exact: true }).click();
      assert.equal(await page.getByLabel('الصف الأول', { exact: true }).isChecked(), false, 'changing sections must discard draft');
      assert.equal(profileWrites, 0, 'changing checkboxes must never write the profile');
      assert.equal(user.subject, saved);
      await page.getByLabel('الصف الأول', { exact: true }).check();
      await page.getByRole('button', { name: 'حفظ اختياراتي', exact: true }).click();
      await root.waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await root.click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الأساسي' }).click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الرياضيات' }).click();
      assert.equal(await page.getByLabel('كل المستويات', { exact: true }).isChecked(), true);
      await page.getByRole('button', { name: 'مواد المجال', exact: true }).click();
      await page.getByRole('button', { name: 'مراحل المنهاج', exact: true }).click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'تعليم القراءة والكتابة' }).click();
      const direct = page.getByLabel('أدرّس هذه المادة', { exact: true });
      await direct.check();
      await page.getByRole('button', { name: 'مواد المجال', exact: true }).click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'تعليم القراءة والكتابة' }).click();
      assert.equal(await direct.isChecked(), false, 'unsaved direct subject must not stay checked');
      assert.equal(profileWrites, 1, 'only the explicit Save may write');
      assert.doesNotMatch(user.subject, /تعليم القراءة والكتابة/);
    } else {
      await page.locator('.home-nearest-tutors .tutor-card').filter({ hasText: 'أستاذ قريب' }).waitFor();
      assert.equal(await page.locator('.home-nearest-tutors .tutor-card').count(), 1, 'only the teacher starting within 15 minutes appears');
      await root.click();
      await page.locator('.package-grid .package-card').filter({ hasText: 'الأساسي' }).click();
      await page.locator('.choice-grid button').filter({ hasText: 'الصف الثاني' }).click();
      await page.locator('.choice-grid button').filter({ hasText: 'الرياضيات' }).click();
      const rail = page.locator('.student-date-picker .availability-day-strip');
      await rail.waitFor();
      const today = new Date().toLocaleDateString('ar-JO', { day: '2-digit' });
      assert.equal(await rail.locator('button strong').first().innerText(), today);
      assert.ok(await rail.locator('.day-availability-dot.available').count() > 0);
      await rail.locator('button').nth(1).click();
      assert.equal(await rail.locator('button.selected').count(), 1);
      const colors = await rail.locator('button.selected').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el.querySelector('strong')).color }));
      assert.notEqual(colors.bg, colors.fg);
      if (theme === 'light') assert.equal(colors.fg, 'rgb(33, 26, 44)');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page should not overflow horizontally');
    }
    await page.screenshot({ path: `${dir}/${portal}-${theme}.png`, fullPage: true });
    await context.close();
    console.log(`${portal} ${theme}: passed`);
  }
} finally { await browser.close(); }
