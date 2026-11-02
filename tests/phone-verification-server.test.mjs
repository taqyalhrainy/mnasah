import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('phone updates save directly and notify the admin section', async () => {
  const ownerToken = 'owner-session-token';
  const studentToken = 'student-session-token';
  const db = memoryMongo({
    users: [
      { id: 'owner', name: 'Owner', email: 'owner@test.com', role: 'admin', status: 'active' },
      { id: 'student', name: 'Student', email: 'student@test.com', role: 'students', status: 'active', phone: '0781111111', subject: '', bio: '', verification: { phone: '0781111111' } },
    ],
    sessions: [
      { user_id: 'owner', token: crypto.createHash('sha256').update(ownerToken).digest('hex'), expires: Date.now() + 3600000 },
      { user_id: 'student', token: crypto.createHash('sha256').update(studentToken).digest('hex'), expires: Date.now() + 3600000 },
    ],
  });
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const post = async (path, body, cookie = '') => {
    const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { response, body: await response.json() };
  };
  try {
    const config = await (await fetch(`${base}/api/public/config`)).json();
    assert.equal('phoneVerificationProvider' in config, false);

    const saved = await post('students/profile', { name: 'Student', subject: '', bio: '', phone: '0791234567' }, `mansah_session_students=${studentToken}`);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.user.phone, '0791234567');
    assert.equal(saved.body.user.verification.phone, '0791234567');

    const invalid = await post('students/profile', { name: 'Student', subject: '', bio: '', phone: '0712345678' }, `mansah_session_students=${studentToken}`);
    assert.equal(invalid.response.status, 400);

    const cookie = `mansah_session_admin=${ownerToken}`;
    const notifications = await (await fetch(`${base}/api/admin/notifications`, { headers: { cookie } })).json();
    assert.equal(notifications.unread, 1);
    assert.equal(notifications.unreadByView.users, 1);
    assert.equal(notifications.notifications[0].title, 'تغيير رقم هاتف');

    const read = await post('admin/notifications', { view: 'users' }, cookie);
    assert.equal(read.body.unread, 0);
    assert.equal(read.body.unreadByView.users, undefined);
  } finally {
    io.close();
    await new Promise(resolve => httpServer.close(resolve));
  }
});
