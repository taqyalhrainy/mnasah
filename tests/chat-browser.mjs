import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

const users = [
  { id: 'teacher-ui', name: 'أحمد الخطيب', email: 'teacher@example.test', role: 'teachers', status: 'active', subject: 'رياضيات', bio: 'أستاذ رياضيات' },
  { id: 'student-ui', name: 'سارة أحمد', email: 'student@example.test', role: 'students', status: 'active', subject: '', bio: '' },
];
const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(`${user.id}-token`).digest('hex'), expires: Date.now() + 3600000 })), slots: [{ id: 'slot-ui', teacher_id: users[0].id, start: Date.now() - 86400000, minutes: 60, price: 1000, subject: 'رياضيات', status: 'booked' }], bookings: [{ id: 'booking-ui', slot_id: 'slot-ui', student_id: users[1].id, status: 'completed', notes: '', resource: '', paid: 1, created: Date.now() - 86400000 }], catalog: [{ id: 'math', kind: 'category', name: 'رياضيات', levels: [], subjects: ['رياضيات'] }] });
const storedFiles = new Map();
const attachmentStore = {
  async write(id, _name, source) { const parts = []; for await (const part of source) parts.push(Buffer.from(part)); storedFiles.set(id, Buffer.concat(parts)); },
  read: id => Readable.from(storedFiles.get(id) || []),
  async remove(id) { storedFiles.delete(id); },
};
const { httpServer, io } = await startPlatformServer({ database: db, attachmentStore, port: 0 });
const base = `http://127.0.0.1:${httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const contexts = []; const errors = [];
async function pageFor(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    class TestMediaRecorder {
      static isTypeSupported() { return true; }
      state = 'inactive'; mimeType = 'audio/webm'; ondataavailable = null; onstop = null; onerror = null;
      constructor() {}
      start() { this.state = 'recording'; }
      stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,1])], { type: this.mimeType }) }); this.onstop?.(); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: TestMediaRecorder });
  });
  await context.addCookies([{ name: `mansah_session_${user.role}`, value: `${user.id}-token`, url: base }]);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/${user.role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.nav-list').getByRole('button', { name: 'الرسائل', exact: true }).click();
  await page.getByRole('button', { name: `محادثة ${user.role === 'students' ? users[0].name : users[1].name}`, exact: true }).waitFor();
  return page;
}
async function layout(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Page must not overflow horizontally');
  const timeline = await page.locator('.dm-timeline').boundingBox();
  const composer = await page.locator('.dm-composer').boundingBox();
  assert.ok(timeline.height > 60 && composer.y >= timeline.y + timeline.height - 1, `Composer must be below a scrollable timeline: ${JSON.stringify({ timeline, composer, viewport: page.viewportSize() })}`);
}
try {
  const student = await pageFor(users[1]); const teacher = await pageFor(users[0]);
  await student.screenshot({ path: '.private/chat-inbox-desktop.png', fullPage: true });
  await student.getByRole('button', { name: `محادثة ${users[0].name}`, exact: true }).click();
  await teacher.getByRole('button', { name: `محادثة ${users[1].name}`, exact: true }).click();
  await student.locator('.dm-conversation-header').waitFor();
  await teacher.locator('.dm-conversation-header').waitFor();
  await student.getByLabel('رسالتك', { exact: true }).fill('مرحباً أستاذ، عندي سؤال عن درس اليوم.');
  await teacher.getByLabel('يكتب الآن', { exact: true }).waitFor({ timeout: 2200 });
  await teacher.getByLabel('يكتب الآن', { exact: true }).waitFor({ state: 'hidden', timeout: 4000 });
  const start = Date.now();
  await student.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await teacher.locator('.dm-message-content').getByText('مرحباً أستاذ، عندي سؤال عن درس اليوم.', { exact: true }).waitFor({ timeout: 2300 });
  assert.ok(Date.now() - start < 2500, 'Delivery should use the realtime signal instead of waiting for the polling interval');
  await student.getByText('تمت القراءة', { exact: true }).waitFor({ timeout: 2500 });
  await teacher.getByRole('button', { name: 'تفاعل مع الرسالة', exact: true }).first().click();
  await teacher.getByRole('button', { name: 'تفاعل ❤️', exact: true }).click();
  await student.getByRole('button', { name: '❤️ 1', exact: true }).waitFor({ timeout: 2500 });
  await teacher.getByRole('button', { name: 'رد على الرسالة', exact: true }).first().click();
  await teacher.getByLabel('رسالتك', { exact: true }).fill('أهلاً سارة، ابعتي سؤالك 😊');
  await teacher.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await student.locator('.dm-reply-quote').waitFor({ timeout: 2500 });
  await student.getByRole('button', { name: 'إيموجي', exact: true }).click();
  await student.getByRole('button', { name: 'إضافة 💜', exact: true }).click();
  assert.equal(await student.getByLabel('رسالتك', { exact: true }).inputValue(), '💜');
  await student.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await teacher.locator('.dm-message-content').getByText('💜', { exact: true }).waitFor();
  await student.getByRole('button', { name: 'صور GIF', exact: true }).click();
  await student.getByRole('button', { name: 'إرسال GIF رائع', exact: true }).click();
  await teacher.locator('.dm-message .dm-gif').waitFor();
  await student.getByLabel('اختيار ملفات').setInputFiles([
    { name: 'واجب-الرياضيات.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 Mansah') },
    { name: 'رسم.png', mimeType: 'image/png', buffer: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]) },
    { name: 'شرح.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0]) },
  ]);
  await student.getByText('واجب-الرياضيات.pdf', { exact: true }).waitFor();
  await student.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await teacher.getByLabel('خيارات المرفق واجب-الرياضيات.pdf', { exact: true }).waitFor({ timeout: 3000 });
  await teacher.getByRole('button', { name: 'فتح رسم.png', exact: true }).click();
  await teacher.getByRole('dialog', { name: 'معاينة رسم.png', exact: true }).waitFor();
  await teacher.getByRole('button', { name: 'إغلاق المعاينة', exact: true }).click();
  await teacher.getByRole('button', { name: 'فتح شرح.mp4', exact: true }).click();
  await teacher.getByRole('dialog', { name: 'معاينة شرح.mp4', exact: true }).waitFor();
  await teacher.getByRole('button', { name: 'إغلاق المعاينة', exact: true }).click();
  await student.getByRole('button', { name: 'تسجيل رسالة صوتية', exact: true }).click();
  await student.getByText('جارٍ التسجيل…', { exact: true }).waitFor();
  await student.getByRole('button', { name: 'إنهاء التسجيل', exact: true }).click();
  await student.getByLabel('معاينة التسجيل الصوتي', { exact: true }).waitFor();
  await student.getByRole('button', { name: 'إرسال الرسالة', exact: true }).click();
  await teacher.getByLabel('تشغيل الرسالة الصوتية', { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await teacher.getByRole('button', { name: /تحميل voice-note-/ }).count(), 0, 'Voice notes must not expose a download action');
  const downloadEvent = teacher.waitForEvent('download');
  await teacher.getByLabel('خيارات المرفق واجب-الرياضيات.pdf', { exact: true }).click();
  await teacher.getByRole('button', { name: 'تحميل واجب-الرياضيات.pdf', exact: true }).click();
  const downloaded = await downloadEvent;
  assert.equal(downloaded.suggestedFilename(), 'واجب-الرياضيات.pdf');
  await teacher.getByRole('button', { name: 'إعدادات الرسائل', exact: true }).click();
  await teacher.getByRole('checkbox', { name: /إظهار تمت القراءة/ }).uncheck();
  await teacher.getByRole('checkbox', { name: /إظهار حالة الاتصال/ }).uncheck();
  await student.getByText('الظهور مخفي', { exact: true }).waitFor({ timeout: 4500 });
  assert.equal(await student.getByText('تمت القراءة', { exact: true }).count(), 0);
  await teacher.getByRole('button', { name: 'إعدادات الرسائل', exact: true }).click();
  await student.getByRole('button', { name: 'بحث في الرسائل', exact: true }).click();
  await student.getByLabel('بحث داخل المحادثة').fill('مرحباً');
  assert.equal(await student.locator('.dm-message').count(), 1);
  await student.getByRole('button', { name: 'إغلاق البحث', exact: true }).click();
  await layout(student);
  await student.screenshot({ path: '.private/chat-conversation-desktop.png', fullPage: true });
  for (const width of [1024, 768, 390, 320]) {
    await student.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await student.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await layout(student);
    if (width === 390) await student.screenshot({ path: '.private/chat-conversation-mobile.png', fullPage: true });
  }
  await student.getByRole('button', { name: 'العودة للمحادثات', exact: true }).click();
  await student.screenshot({ path: '.private/chat-inbox-mobile.png', fullPage: true });
  await student.getByRole('button', { name: `محادثة ${users[0].name}`, exact: true }).click();
  await student.getByLabel('خيارات المحادثة').click();
  await student.getByRole('button', { name: 'كتم المحادثة', exact: true }).click();
  await student.getByRole('button', { name: 'حظر المراسلة', exact: true }).click();
  await teacher.getByText('المراسلة غير متاحة حالياً.', { exact: true }).waitFor();
  assert.equal(await teacher.getByLabel('رسالتك', { exact: true }).isDisabled(), true);
  await student.getByRole('button', { name: 'إلغاء الحظر', exact: true }).click();
  await teacher.getByLabel('رسالتك', { exact: true }).waitFor({ state: 'visible' });
  await teacher.waitForFunction(() => !document.querySelector('.dm-composer textarea').disabled);
  student.on('dialog', dialog => dialog.accept());
  await student.getByRole('button', { name: 'حذف المحادثة عندي', exact: true }).click();
  await student.getByText('تظهر محادثاتك تلقائياً بعد أول حجز.', { exact: true }).waitFor();
  assert.ok(await teacher.locator('.dm-message').count() >= 4, 'Deletion must not clear the other participant history');
  await student.getByRole('button', { name: 'المحادثات المحذوفة', exact: true }).click();
  await student.getByRole('button', { name: `محادثة ${users[0].name}`, exact: true }).click();
  await student.getByRole('button', { name: 'استعادة المحادثة', exact: true }).click();
  assert.equal(await student.locator('.dm-message').count(), 0);
  await student.reload();
  await student.locator('.nav-list').getByRole('button', { name: 'الرسائل', exact: true }).click();
  await student.getByRole('button', { name: `محادثة ${users[0].name}`, exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Chat browser checks passed: two authenticated participants, realtime delivery/typing/seen, privacy, reactions, replies, emoji/GIF, search, mute, block, personal deletion, persistence and desktop/mobile layout.');
} catch (error) {
  for (let index = 0; index < contexts.length; index++) for (const page of contexts[index].pages()) await page.screenshot({ path: `.private/chat-failure-${index}.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => io.close(resolve)); httpServer.close();
}
