import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('WhatsApp fallback creates an admin-approved phone verification', async () => {
  const ownerToken = 'owner-session-token';
  const studentToken = 'student-session-token';
  const db = memoryMongo({
    users: [
      { id: 'owner', name: 'Owner', email: 'owner@test.com', role: 'admin', status: 'active' },
      { id: 'student', name: 'Student', email: 'student@test.com', role: 'students', status: 'active', phone: '0781111111', subject: '', bio: '', verification: { phone: '0781111111', phone_verification_status: 'verified' } },
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
    assert.equal(config.phoneVerificationProvider, 'whatsapp_manual');
    const created = await post('auth/phone-code', { phone: '0791234567' });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.channel, 'whatsapp_manual');
    assert.match(created.body.whatsappUrl, /^https:\/\/wa\.me\/962795764229/);
    assert.equal((await post('auth/phone-code-status', { id: created.body.id, claimToken: created.body.claimToken, phone: '0791234567' })).body.verified, false);

    const cookie = `mansah_session_admin=${ownerToken}`;
    const pending = await (await fetch(`${base}/api/admin/phone-verifications`, { headers: { cookie } })).json();
    assert.equal(pending.requests[0].reference, created.body.reference);
    const unauthorized = await post(`admin/phone-verifications/${created.body.id}/approve`, {});
    assert.equal(unauthorized.response.status, 401);
    const approved = await post(`admin/phone-verifications/${created.body.id}/approve`, {}, cookie);
    assert.equal(approved.response.status, 200);
    assert.equal((await post('auth/phone-code-status', { id: created.body.id, claimToken: created.body.claimToken, phone: '0791234567' })).body.verified, true);

    const saved = await post('students/profile', { name: 'Student', subject: '', bio: '', phone: '0791234567', phone_verification_id: created.body.id, phone_verification_code: created.body.claimToken }, `mansah_session_students=${studentToken}`);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.user.phone, '0791234567');
    assert.equal(saved.body.user.verification.phone_verification_status, 'verified');

    const notifications = await (await fetch(`${base}/api/admin/notifications`, { headers: { cookie } })).json();
    assert.equal(notifications.unread, 2);
    assert.equal(notifications.notifications[0].title, 'تغيير رقم هاتف');
    const read = await post('admin/notifications', {}, cookie);
    assert.equal(read.body.unread, 0);
  } finally {
    io.close();
    await new Promise(resolve => httpServer.close(resolve));
  }
});
