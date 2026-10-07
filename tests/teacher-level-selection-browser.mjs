import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5173';
const context = await browser.newContext();
const page = await context.newPage();
const categories = [{
  id: 'jordan',
  name: 'المنهاج الأردني',
  description: 'جميع الصفوف المدرسية',
  icon: '📚',
  levels: ['الصف الأول', 'الصف الرابع', 'الصف الخامس', 'الصف السابع', 'توجيهي'],
  subjects: ['رياضيات'],
}];
let user = { id: 'teacher-level-check', name: 'Teacher', role: 'teachers', status: 'active', email: 'teacher@example.com', subject: '', bio: '' };
let savedSubject = '';

try {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/teachers/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/teachers/reminders')) return route.fulfill({ json: { bookings: [] } });
    if (path.endsWith('/teachers/home')) return route.fulfill({ json: { bookings: [], slots: [] } });
    if (path.endsWith('/teachers/profile') && request.method() === 'POST') {
      const body = request.postDataJSON();
      savedSubject = body.subject;
      user = { ...user, ...body };
      return route.fulfill({ json: { user } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(`${base}/teachers`);
  await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
  await page.getByText('لتتمكن من إضافة مواعيدك، اختر مادتك أولاً من الصفحة الرئيسية.').waitFor();
  await page.getByRole('button', { name: /الذهاب للرئيسية/ }).click();
  await page.locator('.package-grid .package-card').filter({ hasText: 'رياضيات' }).click();

  const all = page.getByLabel('كل المستويات', { exact: true });
  const first = page.getByLabel('الصف الأول', { exact: true });
  const fourth = page.getByLabel('الصف الرابع', { exact: true });
  const seventh = page.getByLabel('الصف السابع', { exact: true });
  await all.check();
  assert.equal(await first.isChecked(), true, 'selecting all should select every level');
  assert.equal(await seventh.isChecked(), true);
  await first.uncheck();
  assert.equal(await all.isChecked(), false, 'removing one level should clear the all-levels checkbox');
  assert.equal(await fourth.isChecked(), true, 'other levels should remain selected');
  await fourth.uncheck();
  await page.getByRole('button', { name: 'حفظ اختياراتي', exact: true }).click();
  await page.getByText('تم حفظ اختياراتك. اذهب إلى صفحة المتاحة لإعداد وقت نشر مادتك.').waitFor();

  assert.match(savedSubject, /المنهاج الأردني › رياضيات/);
  assert.doesNotMatch(savedSubject, /الصف الأول/);
  assert.doesNotMatch(savedSubject, /الصف الرابع/);
  assert.match(savedSubject, /الصف الخامس/);
  assert.match(savedSubject, /الصف السابع/);
  assert.match(savedSubject, /توجيهي/);
  await page.locator('.nav-list').getByRole('button', { name: 'المتاحة', exact: true }).click();
  await page.locator('.availability-subject-trigger').waitFor();
  assert.match(await page.locator('.availability-subject-trigger').innerText(), /اختر مادة أو أكثر/);
  console.log('Teacher empty-state, subject linking and multi-level selection checks passed.');
} finally {
  await browser.close();
}
