import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('teacher duration preferences persist and public ratings require five distinct students', async t => {
  const now = Date.now();
  const teacher = { id: 'rating-teacher', role: 'teachers', status: 'active', name: 'الأستاذ سامر', email: 'teacher@rating.test', password: 'unused', subject: 'رياضيات' };
  const students = Array.from({ length: 5 }, (_, index) => ({ id: `rating-student-${index + 1}`, role: 'students', status: 'active', name: `طالب ${index + 1}`, email: `student${index + 1}@rating.test`, password: 'unused' }));
  const users = [teacher, ...students];
  const token = user => `${user.id}-token`;
  const sessions = users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token(user)).digest('hex'), expires: now + 3600000 }));
  const slots = students.map((student, index) => ({ id: `rating-slot-${index + 1}`, teacher_id: teacher.id, start: now - (index + 1) * 86400000, available_until: now - (index + 1) * 86400000 + 3600000, minutes: 60, price: 1000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 1000 }], status: 'booked', created: now - 10 * 86400000 }));
  const bookings = students.map((student, index) => ({ id: `rating-booking-${index + 1}`, slot_id: slots[index].id, student_id: student.id, start: slots[index].start, minutes: 60, price: 1000, subject: 'رياضيات', status: 'completed', paid: 1, room: `room-${index + 1}`, created: slots[index].start }));
  const publicSlot = { id: 'public-rating-slot', teacher_id: teacher.id, start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 1000 }], status: 'open', created: now };
  const db = memoryMongo({ users, sessions, slots: [...slots, publicSlot], bookings, ratings: [] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  async function json(portal, user, path, body, expected = 200) {
    const response = await fetch(`${base}/api/${portal}/${path}`, {
      headers: { cookie: `mansah_session_${portal}=${token(user)}`, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
    return result;
  }

  const offerings = [{ minutes: 30, price: 600 }, { minutes: 90, price: 1500 }];
  await json('teachers', teacher, 'availability-preferences', { offerings });
  assert.deepEqual((await json('teachers', teacher, 'availability-preferences')).offerings, offerings);

  for (let index = 0; index < 4; index++) {
    await json('students', students[index], `bookings/${bookings[index].id}/rating`, { rating: 5 - index });
  }
  let listed = (await json('students', students[0], 'slots')).slots.find(slot => slot.id === publicSlot.id);
  assert.equal(listed.teacher_rating_count, 4);
  assert.equal(listed.teacher_rating, null, 'the public average stays hidden before five distinct students rate');

  await json('students', students[4], `bookings/${bookings[4].id}/rating`, { rating: 5 });
  listed = (await json('students', students[0], 'slots')).slots.find(slot => slot.id === publicSlot.id);
  assert.equal(listed.teacher_rating_count, 5);
  assert.equal(listed.teacher_rating, 3.8);

  await json('students', students[0], `bookings/${bookings[0].id}/rating`, { rating: 1 });
  listed = (await json('students', students[0], 'slots')).slots.find(slot => slot.id === publicSlot.id);
  assert.equal(listed.teacher_rating_count, 5, 'updating a rating does not count the same student twice');
  assert.equal(listed.teacher_rating, 3);
});
