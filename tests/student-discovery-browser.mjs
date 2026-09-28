import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const now = Date.now();
const user = { id: 'student-check', name: 'Student', role: 'students', status: 'active', email: 'student@example.com', subject: '', bio: '' };
const slot = { id: 'quran-slot', teacher_id: 'teacher-check', teacher_name: 'Quran Teacher', teacher_subjects: 'تحفيظ القرآن', bio: '', start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'تحفيظ قرآن', status: 'open' };
const categories = [{ id: 'quran', name: 'تحفيظ القرآن الكريم', description: '', icon: 'Q', levels: [], subjects: ['حفظ', 'تلاوة', 'تجويد'] }];

try {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/students/slots')) return route.fulfill({ json: { slots: [slot] } });
    if (path.endsWith('/students/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/students/reminders')) return route.fulfill({ json: { bookings: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://127.0.0.1:8787/students');
  await page.locator('.category-card').click();
  await page.locator('.choice-grid button').first().click();
  const categoryResult = page.locator('.student-flow .tutor-card');
  await categoryResult.waitFor();
  assert.equal(await categoryResult.count(), 1);
  assert.match(await categoryResult.innerText(), /Quran Teacher/);
  console.log('Quran availability discovery check passed.');
} finally {
  await browser.close();
}
