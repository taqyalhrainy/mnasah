import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5192';
await mkdir('.private/clock-catalog', { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(theme => localStorage.setItem('mansah-theme', theme), theme);
    let role = 'admin';
    const catalog = { groups: [{ id: 'quran', name: 'تحفيظ القرآن الكريم', description: '', icon: '📚' }], categories: [] };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: role, role, status: 'active', name: 'أحمد خالد', email: 'demo@test.com', subject: 'تلاوة', bio: '' } } });
      if (path.endsWith('/catalog')) {
        if (route.request().method() === 'POST') catalog.categories.push({ ...route.request().postDataJSON(), id: 'recitation' });
        return route.fulfill({ json: catalog });
      }
      if (path.endsWith('/availability-preferences')) return route.fulfill({ json: { offerings: [{ minutes: 60, price: 1000 }] } });
      return route.fulfill({ json: { bookings: [], slots: [], users: [], events: [] } });
    });
    await page.goto(base + '/owner', { waitUntil: 'domcontentloaded' });
    await page.locator('.nav-list').getByRole('button', { name: 'التصنيفات والمواد', exact: true }).click();
    await page.locator('.catalog-preview-card').filter({ hasText: 'تحفيظ القرآن' }).click();
    await page.getByRole('button', { name: /أضف حصة مباشرة هنا/ }).click();
    await page.getByLabel('الاسم', { exact: true }).fill('تلاوة');
    await page.locator('.catalog-editor-dialog').getByRole('button', { name: 'حفظ', exact: true }).click();
    await page.locator('.catalog-preview-card').filter({ hasText: 'تلاوة' }).waitFor();
    assert.deepEqual(catalog.categories[0].subjects, ['تلاوة']);
    assert.deepEqual(catalog.categories[0].levels, []);
    role = 'teachers';
    await page.goto(base + '/teachers', { waitUntil: 'domcontentloaded' });
    await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
    await page.locator('.time-wheel-trigger').first().click();
    const clock = page.locator('.clock-picker-dialog');
    await clock.waitFor();
    const wheel = clock.getByRole('spinbutton', { name: 'الدقائق', exact: true });
    await wheel.evaluate(element => { element.scrollTop = 4 * 4 * 44 + 3 * 44; });
    await page.waitForTimeout(200);
    assert.equal(await wheel.getAttribute('aria-valuenow'), '45');
    await wheel.focus(); await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(450);
    assert.equal(await wheel.getAttribute('aria-valuenow'), '0', 'minute wheel wraps from 45 to 00');
    await clock.getByRole('button', { name: 'مساءً', exact: true }).click();
    const colors = await clock.locator('.clock-period button.selected').evaluate(el => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
    assert.notEqual(colors.fg, colors.bg);
    if (theme === 'light') assert.equal(colors.fg, 'rgb(36, 27, 45)');
    await page.screenshot({ path: `.private/clock-catalog/time-${theme}.png` });
    await clock.getByRole('button', { name: 'تأكيد الوقت', exact: true }).click();
    assert.equal(await clock.count(), 0);
    assert.match(await page.locator('.time-wheel-trigger').first().getAttribute('data-value'), /:00$/);
    await context.close(); console.log(theme + ' direct catalog + circular clock: passed');
  }
} finally { await browser.close(); }
