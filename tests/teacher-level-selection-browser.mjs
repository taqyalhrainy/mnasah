import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
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

  await page.goto('http://127.0.0.1:8787/teachers');
  await page.locator('.teaching-category-card summary').click();

  const subject = page.getByLabel('تدريس رياضيات', { exact: true });
  const all = page.getByLabel('كل مستويات رياضيات', { exact: true });
  const first = page.getByLabel('رياضيات - الصف الأول', { exact: true });
  const fourth = page.getByLabel('رياضيات - الصف الرابع', { exact: true });
  const seventh = page.getByLabel('رياضيات - الصف السابع', { exact: true });

  await subject.check();
  assert.equal(await all.isChecked(), true, 'selecting the subject should select all levels');
  assert.equal(await first.isChecked(), true);
  assert.equal(await seventh.isChecked(), true);

  await first.uncheck();
  assert.equal(await all.isChecked(), false, 'removing one level should clear the all-levels checkbox');
  assert.equal(await fourth.isChecked(), true, 'other levels should remain selected');
  assert.equal(await subject.isChecked(), true, 'the subject should remain selected while it still has levels');

  await fourth.uncheck();
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await page.getByText('تم حفظ المواد والمستويات التي تدرسها.').waitFor();

  assert.match(savedSubject, /المنهاج الأردني › رياضيات/);
  assert.doesNotMatch(savedSubject, /الصف الأول/);
  assert.doesNotMatch(savedSubject, /الصف الرابع/);
  assert.match(savedSubject, /الصف الخامس/);
  assert.match(savedSubject, /الصف السابع/);
  assert.match(savedSubject, /توجيهي/);
  console.log('Teacher multi-level selection check passed.');
} finally {
  await browser.close();
}
