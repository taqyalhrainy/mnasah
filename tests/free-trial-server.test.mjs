import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('optional 30-minute trial is granted once, claimed atomically, free of wallet charges and safely restored', async t => {
  const now = Date.now(), hour = 3600000;
  const ids = ['teacher-on', 'teacher-off', 'new', 'race', 'veteran', 'package-buyer', 'failure', 'absent', 'manual-absence', 'paid'];
  const users = ids.map(id => ({ id, role: id.startsWith('teacher') ? 'teachers' : 'students', name: id, status: 'active', subject: 'رياضيات', ...(id === 'teacher-on' ? { free_trial_enabled: true } : {}) }));
  const token = id => `trial-token-${id}`;
  const slot = (id, teacher = 'teacher-on', offset = 2, length = 3) => ({ id, teacher_id: teacher, status: 'open', start: now + offset * hour, available_until: now + (offset + length) * hour, minutes: 60, price: 2000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 2000 }], created: now });
  const storage = memoryMongo({ users, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token(user.id)).digest('hex'), expires: now + hour })), catalog: [{ id: 'math', kind: 'category', subjects: ['رياضيات'], levels: [] }], slots: [slot('main'), slot('off', 'teacher-off'), slot('race-a', 'teacher-on', 8), slot('race-b', 'teacher-on', 12), slot('short', 'teacher-on', 20, .5), slot('past', 'teacher-on', -3, 1)], bookings: [{ id: 'old-paid', student_id: 'veteran', slot_id: 'past', status: 'completed', start: now - 3 * hour, minutes: 60, price: 2000 }], package_purchases: [{ id: 'prior-package', student_id: 'package-buyer' }], wallet_accounts: [{ user_id: 'paid', balance: 2000 }] });
  let failInsert = false;
  const db = { collection(name) { const original = storage.collection(name); return name === 'bookings' ? { ...original, async insertOne(row) { if (failInsert && row.student_id === 'failure') { failInsert = false; throw new Error('simulated booking insert failure'); } return original.insertOne(row); } } : original; } };
  const { httpServer, io } = await startPlatformServer({ database: db, port: Number(process.env.TRIAL_TEST_PORT || 0), portalMode: 'public' });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const role = id => id.startsWith('teacher') ? 'teachers' : 'students';
  async function call(id, path, body, status = 200) {
    const response = await fetch(`${base}/api/${role(id)}/${path}`, { headers: { cookie: `mansah_session_${role(id)}=${token(id)}`, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`); return data;
  }
  const trial = (start = now + 2 * hour, minutes = 30) => ({ subject: 'رياضيات', minutes, start, method: 'free_trial' });
  await t.test('teacher consent defaults off and persists independently of profile edits', async () => {
    assert.equal((await call('teacher-off', 'free-trial')).user.free_trial_enabled, false);
    assert.equal((await call('teacher-off', 'free-trial', { enabled: true })).user.free_trial_enabled, true);
    await call('teacher-off', 'profile', { name: 'Teacher', subject: 'رياضيات', bio: '' });
    assert.equal((await call('teacher-off', 'free-trial')).user.free_trial_enabled, true);
    await call('teacher-off', 'free-trial', { enabled: false });
    await call('new', 'free-trial', { enabled: true }, 403);
    assert.equal((await call('new', 'free-trial')).available, true);
    assert.equal((await call('veteran', 'free-trial')).available, false);
    assert.equal((await call('package-buyer', 'free-trial')).available, false);
  });
  await t.test('free booking bypasses an empty wallet and cannot target a nonparticipating teacher or another duration', async () => {
    await call('new', 'slots/off', trial(), 409);
    await call('new', 'slots/main', trial(undefined, 45), 400);
    await call('veteran', 'slots/main', trial(), 409);
    await call('package-buyer', 'slots/main', trial(), 409);
    const result = await call('new', 'slots/main', trial());
    const booking = await db.collection('bookings').findOne({ id: result.id });
    assert.equal(booking.minutes, 30); assert.equal(booking.price, 0); assert.equal(booking.commission_percent, 0);
    assert.equal(booking.is_free_trial, true); assert.equal(booking.payment_ref, 'free_trial');
    assert.equal(await db.collection('wallet_transactions').countDocuments({ user_id: 'new' }), 0);
    assert.equal(await db.collection('wallet_accounts').findOne({ user_id: 'new' }), null);
    assert.equal((await call('new', 'free-trial')).available, false);
    await call('new', 'slots/race-a', trial(now + 8 * hour), 409);
    await call('teacher-on', 'free-trial', { enabled: false });
    assert.equal((await db.collection('bookings').findOne({ id: result.id })).status, 'confirmed');
    await call('absent', 'slots/race-a', trial(now + 8 * hour), 409);
    await call('teacher-on', 'free-trial', { enabled: true });
    await call('new', `bookings/${result.id}/cancel`, {});
    assert.equal((await call('new', 'free-trial')).available, true);
  });
  await t.test('two concurrent claims produce only one free booking and release the losing reservation', async () => {
    const results = await Promise.all(['race-a', 'race-b'].map((id, index) => fetch(`${base}/api/students/slots/${id}`, { method: 'POST', headers: { cookie: `mansah_session_students=${token('race')}`, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(trial(now + (index ? 12 : 8) * hour)) })));
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    assert.equal(await db.collection('bookings').countDocuments({ student_id: 'race', is_free_trial: true }), 1);
    const windows = await db.collection('slots').find({ id: { $in: ['race-a', 'race-b'] } }).toArray();
    assert.equal(windows.reduce((sum, row) => sum + (row.reservations?.length || 0), 0), 1);
  });
  await t.test('a failed write restores the entitlement without creating money or leaving a slot reserved', async () => {
    failInsert = true;
    await call('failure', 'slots/main', trial(now + 3 * hour), 500);
    assert.equal((await call('failure', 'free-trial')).available, true);
    assert.equal(await db.collection('wallet_accounts').findOne({ user_id: 'failure' }), null);
    assert.equal((await db.collection('slots').findOne({ id: 'main' })).reservations.length, 0);
  });
  await t.test('a teacher no-show returns the trial, while student absence consumes it', async () => {
    const result = await call('absent', 'slots/main', trial());
    await db.collection('bookings').updateOne({ id: result.id }, { $set: { start: now - 11 * 60000, student_joined_at: now - 10 * 60000 } });
    await call('absent', 'rooms');
    assert.equal((await db.collection('bookings').findOne({ id: result.id })).status, 'cancelled');
    assert.equal((await call('absent', 'free-trial')).available, true);
    const consumed = await call('new', 'slots/main', trial(now + 3 * hour));
    await db.collection('bookings').updateOne({ id: consumed.id }, { $set: { start: now - hour, teacher_joined_at: now - hour } });
    await call('new', 'rooms');
    assert.equal((await db.collection('bookings').findOne({ id: consumed.id })).status, 'completed');
    assert.equal((await call('new', 'free-trial')).available, false);
    assert.equal(await db.collection('wallet_transactions').countDocuments({ user_id: 'absent' }), 0);
  });
  await t.test('paid bookings remain available and do not consume an already granted trial', async () => {
    assert.equal((await call('paid', 'free-trial')).available, true);
    await call('paid', 'slots/main', { subject: 'رياضيات', minutes: 60, start: now + 4 * hour, method: 'wallet' });
    assert.equal((await db.collection('wallet_accounts').findOne({ user_id: 'paid' })).balance, 0);
    assert.equal((await call('paid', 'free-trial')).available, true);
    const listed = (await call('paid', 'slots')).slots;
    assert.equal(listed.find(row => row.id === 'short').teacher_free_trial_enabled, true);
    assert.equal(listed.find(row => row.id === 'off').teacher_free_trial_enabled, false);
  });
  await t.test('manual absence reports and teacher cancellation restore the credit without refunding money', async () => {
    const absent = await call('manual-absence', 'slots/main', trial(now + 2.5 * hour));
    await db.collection('bookings').updateOne({ id: absent.id }, { $set: { start: now - 11 * 60000 } });
    await call('manual-absence', `bookings/${absent.id}/report-no-show`, {});
    assert.equal((await call('manual-absence', 'free-trial')).available, true);
    assert.equal(await db.collection('wallet_transactions').countDocuments({ user_id: 'manual-absence' }), 0);
    const cancelled = await call('failure', 'slots/main', trial(now + 3.5 * hour));
    await call('teacher-on', `bookings/${cancelled.id}/cancel`, {});
    assert.equal((await call('failure', 'free-trial')).available, true);
    assert.equal((await db.collection('slots').findOne({ id: 'main' })).status, 'open', 'the remaining free 30-minute gap must remain available');
  });
});
