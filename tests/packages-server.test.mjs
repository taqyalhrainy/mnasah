import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('lesson packages expose their own weekly schedule, book matching times, and restore credit on cancellation', async t => {
  const now = Date.now();
  const users = [
    { id: 'package-teacher', role: 'teachers', status: 'active', name: 'الأستاذة رنا', email: 'teacher@package.test', password: 'unused', subject: 'المناهج › رياضيات' },
    { id: 'package-student', role: 'students', status: 'active', name: 'ليان', email: 'student@package.test', password: 'unused' },
  ];
  const token = role => `${role}-package-token`;
  const sessions = users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token(user.role)).digest('hex'), expires: now + 3600000 }));
  const slot = { id: 'package-slot', teacher_id: 'package-teacher', start: now + 3600000, available_until: now + 4 * 3600000, minutes: 60, price: 2000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 2000 }], status: 'open', created: now };
  const db = memoryMongo({ users, sessions, slots: [slot], catalog: [{ id: 'math', kind: 'category', position: 0, name: 'المناهج', levels: [], subjects: ['رياضيات'] }], wallet_accounts: [{ user_id: 'package-student', balance: 10000, updated: now }] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const cookie = role => `mansah_session_${role}=${token(role)}`;
  async function json(role, path, body, expected = 200) {
    const response = await fetch(`${base}/api/${role}/${path}`, { headers: { cookie: cookie(role), origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
  }

  const weekly_schedule = Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: '00:00', to: '23:59' }));
  await json('teachers', 'lesson-packages', { name: 'مادة غير معتمدة', subjects: ['مادة خارج القائمة'], lesson_count: 4, minutes: 60, price: 6000, validity_days: 90, weekly_schedule }, 400);
  const created = await json('teachers', 'lesson-packages', { name: 'تأسيس الرياضيات', description: 'أربع حصص تأسيسية', subjects: ['رياضيات'], lesson_count: 4, minutes: 60, price: 6000, validity_days: 90, weekly_schedule });
  assert.equal(created.package.lesson_count, 4);
  const market = await json('students', 'lesson-packages');
  assert.equal(market.offers.length, 1); assert.equal(market.offers[0].teacher_name, 'الأستاذة رنا');

  const purchase = (await json('students', `lesson-packages/${created.package.id}/purchase`, {})).purchase;
  assert.equal(purchase.remaining_lessons, 4);
  assert.equal((await json('students', 'wallet')).balance, 4000);
  const listed = await json('students', 'lesson-packages');
  assert.equal(listed.purchases[0].status, 'active');

  const availability = await json('students', `package-purchases/${purchase.id}/availability`);
  assert.ok(availability.days.length > 0); assert.ok(availability.days[0].starts.length > 0);
  const booking = await json('students', `package-purchases/${purchase.id}/book`, { subject: 'رياضيات', start: availability.days[0].starts[0] });
  assert.equal((await json('students', 'wallet')).balance, 4000, 'package booking must not debit the wallet again');
  assert.equal((await json('students', 'lesson-packages')).purchases[0].remaining_lessons, 3);
  const booked = (await json('students', 'overview')).bookings.find(item => item.id === booking.id);
  assert.equal(booked.package_purchase_id, purchase.id); assert.equal(booked.payment_ref, `package:${purchase.id}`);

  const quote = await json('students', `bookings/${booking.id}/cancellation`);
  assert.equal(quote.quote.packageCredit, true);
  await json('students', `bookings/${booking.id}/cancel`, {});
  assert.equal((await json('students', 'lesson-packages')).purchases[0].remaining_lessons, 4, 'cancellation restores one package lesson');
  assert.equal((await json('students', 'wallet')).balance, 4000);

  await json('teachers', `lesson-packages/${created.package.id}/archive`, {});
  assert.equal((await json('students', 'lesson-packages')).offers.length, 0);
  await json('students', `lesson-packages/${created.package.id}/purchase`, {}, 409);
  const teacherPackages = await json('teachers', 'lesson-packages');
  assert.equal(teacherPackages.packages[0].sold_count, 1);
});
