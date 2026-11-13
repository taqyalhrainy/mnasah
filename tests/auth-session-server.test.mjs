import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('an Atlas quota error during renewal preserves an already valid login', async () => {
  const baseDb = memoryMongo({ users: [{ id: 'student', role: 'students', name: 'Student', status: 'active' }], sessions: [{ token: crypto.createHash('sha256').update('valid-token').digest('hex'), user_id: 'student', expires: Date.now() + 3600000 }] });
  const db = { collection(name) { const collection = baseDb.collection(name); return name === 'sessions' ? { ...collection, async updateOne() { throw new Error('you are over your space quota. Writes are blocked on your cluster.'); } } : collection; } };
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0, portalMode: 'public' });
  try {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/auth/me?portal=students`, { headers: { cookie: 'mansah_session_students=valid-token' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, 'student');
    assert.equal(response.headers.get('set-cookie'), null);
  } finally { await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
});

test('root discovers saved learning sessions, renews persistent cookie and respects logout/expiry/owner isolation', async () => {
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const db = memoryMongo({ users: [
    { id: 'teacher', role: 'teachers', name: 'Teacher', status: 'active' },
    { id: 'student', role: 'students', name: 'Student', status: 'active' },
    { id: 'owner', role: 'admin', name: 'Owner', status: 'active' },
  ], sessions: [
    { token: hash('teacher-token'), user_id: 'teacher', expires: Date.now() + 3600000 },
    { token: hash('student-expired'), user_id: 'student', expires: Date.now() - 1000 },
    { token: hash('owner-token'), user_id: 'owner', expires: Date.now() + 3600000 },
  ] });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0, portalMode: 'public' });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const cookies = { cookie: 'mansah_session_teachers=teacher-token' };
    const wrong = await fetch(`${base}/api/auth/me?portal=students`, { headers: cookies });
    assert.equal((await wrong.json()).user, null);
    const restore = await fetch(`${base}/api/auth/me?portal=students&discover=1`, { headers: cookies });
    assert.equal((await restore.json()).user.id, 'teacher');
    assert.match(restore.headers.get('set-cookie'), /mansah_session_teachers=teacher-token; Path=\/; HttpOnly/);
    assert.ok(Number(restore.headers.get('set-cookie').match(/Max-Age=(\d+)/)[1]) >= 364 * 86400);
    assert.match(restore.headers.get('set-cookie'), /Expires=/);
    assert.ok((await db.collection('sessions').findOne({ token: hash('teacher-token') })).expires > Date.now() + 364 * 86400000);
    assert.equal((await (await fetch(`${base}/api/auth/me?portal=students&discover=1`, { headers: { cookie: 'mansah_session_students=student-expired' } })).json()).user, null);
    assert.equal((await (await fetch(`${base}/api/auth/me?portal=students&discover=1`, { headers: { cookie: 'mansah_session_admin=owner-token' } })).json()).user, null);
    await fetch(`${base}/api/auth/logout?portal=teachers`, { method: 'POST', headers: { ...cookies, 'content-type': 'application/json', origin: base }, body: '{"role":"teachers"}' });
    assert.equal((await (await fetch(`${base}/api/auth/me?portal=teachers`, { headers: cookies })).json()).user, null);
  } finally { await new Promise(resolve => io.close(() => httpServer.close(resolve))); }
});
