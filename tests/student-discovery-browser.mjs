import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const now = Date.now();
const user = { id: 'student-check', name: 'Student', role: 'students', status: 'active', email: 'student@example.com', subject: '', bio: '' };
const slots = [
  { id: 'quran-slot', teacher_id: 'teacher-check', teacher_name: 'Quran Teacher', teacher_subjects: 'تحفيظ القرآن', bio: '', start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'تحفيظ قرآن', status: 'open' },
  { id: 'math-five', teacher_id: 'teacher-five', teacher_name: 'Fifth Grade Teacher', teacher_subjects: 'المنهاج الأردني › رياضيات › الصف الخامس، الصف السابع', bio: '', start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'رياضيات', status: 'open' },
  { id: 'math-four', teacher_id: 'teacher-four', teacher_name: 'Fourth Grade Teacher', teacher_subjects: 'المنهاج الأردني › رياضيات › الصف الرابع', bio: '', start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'رياضيات', status: 'open' },
];
const categories = [
  { id: 'quran', name: 'تحفيظ القرآن الكريم', description: '', icon: 'Q', levels: [], subjects: ['حفظ', 'تلاوة', 'تجويد'] },
  { id: 'jordan', name: 'المنهاج الأردني', description: '', icon: 'J', levels: ['الصف الرابع', 'الصف الخامس', 'الصف السابع'], subjects: ['رياضيات'] },
];

try {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user } });
    if (path.endsWith('/students/slots')) return route.fulfill({ json: { slots } });
    if (path.endsWith('/students/catalog')) return route.fulfill({ json: { categories } });
    if (path.endsWith('/students/reminders')) return route.fulfill({ json: { bookings: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://127.0.0.1:8787/students');
  await page.locator('.category-card').filter({ hasText: 'تحفيظ القرآن الكريم' }).click();
  await page.locator('.choice-grid button').first().click();
  const categoryResult = page.locator('.student-flow .tutor-card');
  await categoryResult.waitFor();
  assert.equal(await categoryResult.count(), 1);
  assert.match(await categoryResult.innerText(), /Quran Teacher/);
  await page.locator('.back-to-categories').click();
  await page.locator('.category-card').filter({ hasText: 'المنهاج الأردني' }).click();
  await page.locator('.choice-grid button').filter({ hasText: 'الصف الخامس' }).click();
  await page.locator('.choice-grid button').filter({ hasText: 'رياضيات' }).click();
  const levelResults = page.locator('.student-flow .tutor-card');
  await levelResults.first().waitFor();
  assert.equal(await levelResults.count(), 1, 'only teachers who selected the student level should appear');
  assert.match(await levelResults.first().innerText(), /Fifth Grade Teacher/);
  assert.doesNotMatch(await levelResults.first().innerText(), /Fourth Grade Teacher/);
  console.log('Quran and teacher level discovery checks passed.');
} finally {
  await browser.close();
}
