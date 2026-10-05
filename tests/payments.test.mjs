import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { paymentRange, paymentSummary, paymentMidnight, paymentDay } from '../shared/payments.js';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import worker from '../dist/server/index.js';
import { digest } from '../worker/auth.js';

test('Amman date boundaries, ranges, integer accounting and completion-only totals', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(paymentDay(Date.parse('2026-10-04T21:00:00Z')), '2026-10-05');
  assert.equal(paymentMidnight('2026-10-05'), Date.parse('2026-10-04T21:00:00Z'));
  const range = paymentRange({ start: '2026-09-28', end: '2026-10-04' }, now);
  assert.equal(range.until, paymentMidnight('2026-10-05'));
  assert.deepEqual(paymentRange({}, now), { start: '2026-10-05', end: '2026-10-05', from: paymentMidnight('2026-10-05'), until: paymentMidnight('2026-10-06') });
  for (const query of [{ start: '2026-02-30', end: '2026-03-01' }, { start: '2026-09-01', end: '2026-10-04' }, { start: '2026-10-05', end: '2026-10-06' }, { start: '2026-10-05', end: '2026-10-04' }]) assert.throws(() => paymentRange(query, now), { status: 400 });
  const seed = { teacher_id: 't', teacher_name: 'Teacher', price: 1500, minutes: 60, status: 'completed', paid: 1, start: range.from };
  const result = paymentSummary([{ ...seed, id: '1' }, { ...seed, id: '2', price: 1200, paid: 0, minutes: 30, start: range.until - 1 }, { ...seed, start: range.until }, { ...seed, status: 'cancelled' }, { ...seed, status: 'confirmed' }], range, 15);
  assert.deepEqual(result.summary, { gross: 2700, fee: 405, net: 2295, collected: 1500, uncollected: 1200, minutes: 90, lessons: 2, averageHourly: 1800 });
  assert.equal(result.teachers[0].net, result.summary.net);
  assert.equal(result.days.length, 2);
  const rounded = paymentSummary([{ ...seed, price: 101 }, { ...seed, price: 101 }], range, 15);
  assert.equal(rounded.summary.fee, 30, 'Round once per lesson and use the same amounts in every subtotal');
  assert.deepEqual(paymentSummary([], range).summary, { gross: 0, fee: 0, net: 0, collected: 0, uncollected: 0, minutes: 0, lessons: 0, averageHourly: 0 });
});

test('Mongo payments are protected, teacher-scoped and not truncated at 500 lessons', async () => {
  const users = [{ id: 'owner', name: 'Owner', role: 'admin' }, { id: 'teacher', name: 'Teacher', role: 'teachers' }, { id: 'other', name: 'Other teacher', role: 'teachers' }, { id: 'student', name: 'Student', role: 'students' }].map(user => ({ ...user, status: 'active' }));
  const range = paymentRange({});
  const slots = Array.from({ length: 505 }, (_, index) => ({ id: `s${index}`, teacher_id: index === 504 ? 'other' : 'teacher', start: range.from, price: 1000, minutes: 60, subject: 'Math' }));
  const bookings = slots.map(slot => ({ id: `b${slot.id}`, slot_id: slot.id, student_id: 'student', status: 'completed', paid: 1, room: 'private-room' }));
  const db = memoryMongo({ users, slots, bookings, sessions: users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: Date.now() + 3600000 })) });
  const server = await startPlatformServer({ database: db, port: 0 });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function call(user, path = 'payments', status = 200, method = 'GET') {
    const role = users.find(row => row.id === user)?.role || 'admin';
    const response = await fetch(`${base}/api/${role}/${path}`, { method, headers: { cookie: `mansah_session_${role}=${user}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  try {
    const result = await call('owner'); assert.equal(result.summary.lessons, 505); assert.equal(result.summary.gross, 505000); assert.equal(result.teachers.length, 2); assert.ok(result.bookings.every(row => !row.room));
    assert.equal((await call('teacher')).summary.lessons, 504); assert.equal((await call('other')).summary.lessons, 1);
    await call('guest', 'payments', 401); await call('student', 'payments', 404); await call('owner', 'payments', 404, 'POST'); await call('owner', 'payments?start=2026-02-30&end=2026-03-01', 400);
  } finally { server.io.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
});

test('D1 payments use the same totals and enforce account access', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  const DB = { prepare: sql => ({ bind(...args) { const statement = sqlite.prepare(sql); return { first: () => statement.get(...args), all: () => ({ results: statement.all(...args) }), run: () => ({ meta: { changes: Number(statement.run(...args).changes) } }) }; } }) };
  const range = paymentRange({});
  const tokens = Object.fromEntries(['owner', 'teacher', 'other', 'student'].map(id => [id, crypto.createHash('sha256').update(id).digest('hex')]));
  for (const [id, role] of [['owner', 'admin'], ['teacher', 'teachers'], ['other', 'teachers'], ['student', 'students']]) {
    sqlite.prepare("INSERT INTO users (id,email,name,role,status,password,subject,bio,created) VALUES (?,?,?,?,'active','unused','','',0)").run(id, `${id}@test.example`, id, role);
    sqlite.prepare('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)').run(await digest(tokens[id]), id, Date.now() + 3600000);
  }
  sqlite.prepare("INSERT INTO slots (id,teacher_id,start,minutes,price,subject,status) VALUES ('s','teacher',?,60,1500,'Math','booked')").run(range.from);
  sqlite.prepare("INSERT INTO bookings (id,slot_id,student_id,status,room,paid,payment_ref,notes,resource,created) VALUES ('b','s','student','completed','private',1,'receipt','','',0)").run();
  const env = { DB, ASSETS: { fetch: () => new Response('asset') } };
  async function call(id, role, expected = 200) {
    const response = await worker.fetch(new Request(`https://test.example/api/${role}/payments`, { headers: { cookie: `mansah_session_${role}=${tokens[id]}` } }), env);
    assert.equal(response.status, expected); return response.json();
  }
  try {
    const result = await call('owner', 'admin'); assert.equal(result.summary.net, 1275); assert.equal(result.summary.fee, 225); assert.ok(!result.bookings[0].room);
    assert.equal((await call('teacher', 'teachers')).summary.gross, 1500); assert.equal((await call('other', 'teachers')).summary.lessons, 0);
    await call('student', 'students', 404); await call('teacher', 'admin', 403);
  } finally { sqlite.close(); }
});
