import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import { paymentSummary } from '../shared/payments.js';

test('admin exemption is reversible, teacher-only and preserves existing agreed fees', async t => {
  const now = Date.now();
  const users = [
    { id: 'owner', role: 'admin', status: 'active', name: 'Owner', email: 'owner@test.invalid' },
    { id: 'teacher', role: 'teachers', status: 'active', name: 'Teacher', email: 'teacher@test.invalid' },
    { id: 'student', role: 'students', status: 'active', name: 'Student', email: 'student@test.invalid' },
  ];
  const db = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: now + 3600000 })), slots: [{ id: 'old-slot', teacher_id: 'teacher' }], bookings: [{ id: 'old', slot_id: 'old-slot', status: 'completed', price: 1000, start: now, minutes: 60 }], package_purchases: [{ id: 'old-package', teacher_id: 'teacher' }] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  async function call(role, id, body, status = 200) {
    const response = await fetch(`${base}/api/${role}/users/${id}`, { method: 'POST', headers: { cookie: `mansah_session_${role}=${role === 'admin' ? 'owner' : 'student'}`, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.text());
  }
  await call('students', 'teacher', { commission_exempt: true }, 404);
  await call('admin', 'student', { commission_exempt: true }, 400);
  await call('admin', 'teacher', { commission_exempt: true });
  assert.equal((await db.collection('users').findOne({ id: 'teacher' })).commission_exempt, true);
  assert.equal((await db.collection('bookings').findOne({ id: 'old' })).commission_percent, 10);
  assert.equal((await db.collection('package_purchases').findOne({ id: 'old-package' })).commission_percent, 10);
  await db.collection('wallet_accounts').insertOne({ user_id: 'student', balance: 3000 });
  await db.collection('slots').insertOne({ id: 'new-slot', teacher_id: 'teacher', start: now + 3600000, available_until: now + 7200000, status: 'open', subject: 'Math', subjects: ['Math'], minutes: 60, price: 1000, offerings: [{ minutes: 60, price: 1000 }] });
  const booked = await fetch(`${base}/api/students/slots/new-slot`, { method: 'POST', headers: { cookie: 'mansah_session_students=student', origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'Math', minutes: 60 }) });
  assert.equal(booked.status, 200, await booked.clone().text());
  const booking = await booked.json();
  assert.equal((await db.collection('bookings').findOne({ id: booking.id })).commission_percent, 0, 'new real bookings inherit the teacher exemption');
  await db.collection('bookings').insertOne({ id: 'exempt', slot_id: 'old-slot', commission_percent: 0, status: 'completed', price: 1000, start: now, minutes: 60 });
  await call('admin', 'teacher', { commission_exempt: false });
  assert.equal((await db.collection('users').findOne({ id: 'teacher' })).commission_exempt, false);
  const rows = await db.collection('bookings').find({}).toArray();
  const report = paymentSummary(rows, { from: now - 1, until: now + 1 });
  assert.equal(report.bookings.find(row => row.id === 'exempt').fee, 0);
  assert.equal(report.summary.fee, 100);
  assert.equal(report.summary.net, 1900);
});
