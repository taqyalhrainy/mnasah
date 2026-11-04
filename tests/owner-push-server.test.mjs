import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { memoryMongo } from './helpers/memory-mongo.mjs';
import { notifyPlatformOwners } from '../shared/device-push.js';

const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
const { startPlatformServer } = await import('../server/index.js');

test('owner phone subscriptions receive audit pushes, test only their device, and unsubscribe independently', async t => {
  const users = ['admin', 'students'].map(role => ({ id: role, role, status: 'active', name: role, email: `${role}@push.test`, phone: '0791111111', subject: '', bio: '' }));
  const sessions = users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(user.id).digest('hex'), expires: Date.now() + 3600000 }));
  const db = memoryMongo({ users, sessions });
  const delivered = [];
  const original = webpush.sendNotification;
  webpush.sendNotification = async (subscription, payload) => {
    if (subscription.endpoint.endsWith('/expired')) throw { statusCode: 410 };
    delivered.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  };
  const { httpServer, io } = await startPlatformServer({ database: db, port: 0 });
  t.after(async () => { webpush.sendNotification = original; await new Promise(resolve => io.close(() => httpServer.close(resolve))); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const subscription = name => ({ endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: keys.publicKey, auth: crypto.randomBytes(16).toString('base64url') } });
  async function call(role, path, body, expected = 200) {
    const response = await fetch(`${base}/api/${role}/${path}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', cookie: `mansah_session_${role}=${role}` }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const one = subscription('owner-phone'), two = subscription('owner-tablet'), expired = subscription('expired');
  await call('admin', 'push/subscribe', { subscription: { ...one, endpoint: 'https://127.0.0.1/private' } }, 400);
  for (const sub of [one, two, expired]) await call('admin', 'push/subscribe', { subscription: sub });
  await call('students', 'push/subscribe', { subscription: subscription('student-phone') });
  assert.equal((await call('admin', 'push/status', { endpoint: one.endpoint })).enabled, true);
  assert.equal((await call('students', 'push/status', { endpoint: one.endpoint })).enabled, false);
  await call('students', 'profile', { name: 'الطالب', phone: '0792222222', subject: '', bio: '' });
  for (let i = 0; i < 30 && delivered.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(delivered.map(row => row.endpoint).sort(), [one.endpoint, two.endpoint].sort());
  assert.ok(delivered.every(row => row.payload.url === '/owner?view=users'));
  assert.equal(await db.collection('push_subscriptions').findOne({ endpoint: expired.endpoint }), null);
  delivered.length = 0;
  await call('admin', 'push/test', { endpoint: one.endpoint });
  assert.deepEqual(delivered.map(row => row.endpoint), [one.endpoint]);
  await call('admin', 'push/unsubscribe', { endpoint: one.endpoint });
  assert.equal((await call('admin', 'push/status', { endpoint: one.endpoint })).enabled, false);
  assert.equal((await call('admin', 'push/status', { endpoint: two.endpoint })).enabled, true);
});

test('admin pushes include only active owners and open their relevant section', async () => {
  const db = memoryMongo({ users: [{ id: 'owner', role: 'admin', status: 'active' }, { id: 'blocked', role: 'admin', status: 'suspended' }, { id: 'teacher', role: 'teachers', status: 'active' }] });
  const sent = [];
  await notifyPlatformOwners(db, async (id, payload) => sent.push({ id, payload }), { id: 'topup-1', title: 'شحن محفظة', body: 'طلب جديد', view: 'topups' });
  assert.equal(sent.length, 1); assert.equal(sent[0].id, 'owner'); assert.equal(sent[0].payload.url, '/owner?view=topups');
});
