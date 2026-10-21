import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { startPlatformServer } from '../server/index.js';
import { memoryMongo } from './helpers/memory-mongo.mjs';

test('Mongo wallet top-ups require admin approval and bookings debit and refund once', async t => {
  const now = Date.now();
  const users = [
    { id: 'admin-wallet', role: 'admin', status: 'active', name: 'Admin', email: 'admin@wallet.test', password: 'unused' },
    { id: 'teacher-wallet', role: 'teachers', status: 'active', name: 'Teacher', email: 'teacher@wallet.test', password: 'unused' },
    { id: 'student-wallet', role: 'students', status: 'active', name: 'Student', email: 'student@wallet.test', password: 'unused' },
  ];
  const token = role => `${role}-wallet-token`;
  const sessions = users.map(user => ({ user_id: user.id, token: crypto.createHash('sha256').update(token(user.role)).digest('hex'), expires: now + 3600000 }));
  const db = memoryMongo({ users, sessions, slots: [{ id: 'wallet-slot', teacher_id: 'teacher-wallet', start: now + 3600000, available_until: now + 7200000, minutes: 60, price: 1000, subject: 'رياضيات', subjects: ['رياضيات'], offerings: [{ minutes: 60, price: 1000 }], status: 'open', created: now }] });
  const stored = new Map();
  const topupProofStore = {
    async write(id, _name, source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); stored.set(id, Buffer.concat(chunks)); },
    read(id) { return Readable.from([stored.get(id)]); },
    async remove(id) { stored.delete(id); },
  };
  const { httpServer, io } = await startPlatformServer({ database: db, topupProofStore, port: 0 });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const cookie = role => `mansah_session_${role}=${token(role)}`;
  async function json(role, path, body, expected = 200) {
    const response = await fetch(`${base}/api/${role}/${path}`, { headers: { cookie: cookie(role), origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
  }
  assert.equal((await json('students', 'wallet')).balance, 0);
  await json('students', 'slots/wallet-slot', { subject: 'رياضيات', minutes: 60, method: 'wallet' }, 402);
  await json('admin', 'wallet-topups/settings', { cliq_name: '', cliq_alias: 'TAQY123' });
  const configuredWallet = await json('students', 'wallet');
  assert.equal(configuredWallet.payment.ready, true);
  assert.equal(configuredWallet.payment.cliq_alias, 'TAQY123');
  const receipt = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const query = new URLSearchParams({ amount: '15', reference: 'MONGO-1001', name: 'receipt.png', size: String(receipt.length), type: 'image/png' });
  const upload = await fetch(`${base}/api/students/wallet/topups?${query}`, { method: 'POST', headers: { cookie: cookie('students'), origin: base, 'content-type': 'application/octet-stream' }, body: receipt });
  assert.equal(upload.status, 200); const topup = (await upload.json()).topup; assert.equal(topup.status, 'pending');
  const proof = await fetch(`${base}/api/admin/wallet/topups/${topup.id}/proof`, { headers: { cookie: cookie('admin') } });
  assert.equal(proof.status, 200); assert.deepEqual(Buffer.from(await proof.arrayBuffer()), receipt);
  await json('admin', `wallet-topups/${topup.id}/approve`, {});
  await json('admin', `wallet-topups/${topup.id}/approve`, {}, 409);
  assert.equal((await json('students', 'wallet')).balance, 1500);
  const booking = await json('students', 'slots/wallet-slot', { subject: 'رياضيات', minutes: 60, method: 'wallet' });
  assert.equal((await json('students', 'wallet')).balance, 500);
  await json('students', `bookings/${booking.id}/cancel`, {});
  await json('students', `bookings/${booking.id}/cancel`, {}, 409);
  assert.equal((await json('students', 'wallet')).balance, 1500);
  const transactions = (await json('students', 'wallet')).transactions;
  assert.deepEqual(transactions.map(row => row.type).sort(), ['cliq_topup', 'lesson_payment', 'lesson_refund'].sort());
});
