import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { paymentDb } from './helpers/payment-mongo.mjs';
import { cardSettings, serveCardWallet, processCardCallback } from '../server/card-wallet.js';
import { startPlatformServer } from '../server/index.js';

const env = { PAYTABS_ENABLED: 'true', PAYTABS_PROFILE_ID: '12345', PAYTABS_SERVER_KEY: 'test-secret-not-a-real-live-key', PAYTABS_PUBLIC_ORIGIN: 'https://emtidad-alelm.onrender.com' };
const user = { id: 'card-student', role: 'students', name: 'Test Student', email: 'student@example.com', phone: '0790000000' };
const rejects = (promise, status) => assert.rejects(promise, e => e.status === status);
function setup() {
  const db = paymentDb(), audits = [];
  const walletAccount = async id => { await db.collection('wallet_accounts').updateOne({ user_id: id }, { $setOnInsert: { user_id: id, balance: 0 } }, { upsert: true }); return db.collection('wallet_accounts').findOne({ user_id: id }); };
  const audit = async (...args) => audits.push(args);
  const context = { db, user, path: 'wallet/card', validOrigin: true, walletAccount, audit, env };
  let serial = 0;
  const create = async (amount = '10', overrides = {}) => {
    let output;
    const fetchImpl = async (url, options) => {
      assert.equal(url, 'https://secure-jordan.paytabs.com/payment/request');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, env.PAYTABS_SERVER_KEY);
      const body = JSON.parse(options.body);
      assert.equal(body.cart_currency, 'JOD'); assert.equal(body.cart_amount, '10.000');
      assert.deepEqual(body.payment_methods, ['creditcard']); assert.equal(body.customer_details.email, user.email);
      assert.ok(!body.customer_details.street1); assert.equal(body.hide_shipping, true);
      return Response.json({ cart_id: body.cart_id, tran_ref: `LIVE_${++serial}`, redirect_url: 'https://secure-jordan.paytabs.com/payment/page/valid' });
    };
    await serveCardWallet({ method: 'POST', body: { amount } }, { setHeader() {}, json(value) { output = value; } }, { ...context, fetchImpl, ...overrides });
    return db.collection('card_orders').findOne({ id: output.order.id });
  };
  const fields = (order, extra = {}) => ({ profile_id: 12345, tran_ref: order.tran_ref, tran_type: 'Sale', tran_class: 'ECom', cart_id: order.id, cart_currency: 'JOD', cart_amount: '10.000', tran_currency: 'JOD', tran_total: '10.000', payment_result: { response_status: 'A' }, ...extra });
  const send = async (payload, overrides = {}) => { const raw = Buffer.from(JSON.stringify(payload)); return processCardCallback(raw, crypto.createHmac('sha256', env.PAYTABS_SERVER_KEY).update(raw).digest('hex'), { ...context, ...overrides }); };
  return { ...context, audits, create, fields, send, balance: async () => (await walletAccount(user.id)).balance };
}
test('card checkout requires explicit live configuration, exact amount, student role and same origin', async () => {
  assert.equal(cardSettings({}).ready, false);
  assert.equal(cardSettings(env).ready, true);
  assert.ok(!JSON.stringify(cardSettings(env)).includes(env.PAYTABS_SERVER_KEY));
  assert.equal(cardSettings({ ...env, PAYTABS_PUBLIC_ORIGIN: 'https://evil.test' }).ready, false);
  const s = setup(), order = await s.create();
  assert.equal(order.amount, 1000); assert.equal(await s.balance(), 0);
  for (const amount of ['0', '-1', '1.001', '1.000', '1e3', '10001', {}, null]) await rejects(s.create(amount), 400);
  await rejects(s.create('10', { validOrigin: false }), 403);
  await rejects(s.create('10', { user: { ...user, role: 'teachers' } }), 403);
  await rejects(s.create('10', { env: {} }), 503);
  await rejects(s.create('10', { fetchImpl: async () => { throw Error('offline'); } }), 503);
  for (const url of ['https://evil.com/payment/page/a', 'http://secure-jordan.paytabs.com/payment/page/a', 'https://secure-jordan.paytabs.com.evil.com/payment/page/a']) await rejects(s.create('10', { fetchImpl: async (_, o) => Response.json({ cart_id: JSON.parse(o.body).cart_id, tran_ref: 'LIVE_999', redirect_url: url }) }), 502);
  await rejects(s.create('10', { fetchImpl: async (_, o) => Response.json({ cart_id: JSON.parse(o.body).cart_id, tran_ref: 'TST123456', redirect_url: 'https://secure-jordan.paytabs.com/payment/page/a' }) }), 502);
  await rejects(serveCardWallet({ method: 'GET' }, { setHeader() {} }, { ...s, user: { ...user, id: 'other' }, path: `wallet/card/${order.id}` }), 404);
});
test('raw HMAC authentication, exact JOD/profile/transaction matching, pending and auth never credit', async () => {
  const s = setup(), order = await s.create();
  await rejects(processCardCallback(Buffer.from('{}'), '0'.repeat(64), { ...s, env: {} }), 503);
  await rejects(processCardCallback(Buffer.from('{}'), '0'.repeat(64), { ...s, env }), 403);
  await rejects(processCardCallback(Buffer.alloc(65537), '0'.repeat(64), { ...s, env }), 403);
  for (const extra of [{ profile_id: 999 }, { tran_ref: 'WRONG_REF' }, { tran_ref: 'TST12345' }, { previous_tran_ref: 'ANOTHER' }, { cart_currency: 'USD' }, { tran_currency: 'USD' }, { tran_total: '9.999' }, { cart_amount: '9.00' }]) await rejects(s.send(s.fields(order, extra)), 400);
  for (const extra of [{ payment_result: { response_status: 'P' } }, { payment_result: { response_status: 'H' } }, { payment_result: { response_status: 'D' } }, { tran_type: 'Auth' }]) await s.send(s.fields(order, extra));
  assert.equal(await s.balance(), 0);
});
test('concurrent/repeated payment and partial refunds credit/debit exactly once, including refund before sale', async () => {
  const s = setup(), order = await s.create();
  await Promise.all(Array.from({ length: 16 }, () => s.send(s.fields(order))));
  assert.equal(await s.balance(), 1000);
  const refund = s.fields(order, { tran_type: 'Refund', tran_ref: 'REFUND_1', previous_tran_ref: order.tran_ref, tran_total: '2.000' });
  await Promise.all(Array.from({ length: 10 }, () => s.send(refund)));
  assert.equal(await s.balance(), 800);
  await rejects(s.send({ ...refund, tran_total: '3.000' }), 400);
  await rejects(s.send({ ...refund, tran_ref: 'REFUND_2', tran_total: '9.000' }), 400);
  assert.equal(await s.balance(), 800);
  const other = await s.create();
  await s.send(s.fields(other, { tran_type: 'Refund', tran_ref: 'REFUND_3', previous_tran_ref: other.tran_ref, tran_total: '10.000' }));
  assert.equal(await s.balance(), 800);
  await s.send(s.fields(other));
  assert.equal(await s.balance(), 800);
  assert.equal((await s.db.collection('card_orders').findOne({ id: other.id })).status, 'refunded');
  assert.equal((await s.db.collection('wallet_transactions').find({}).toArray()).length, 4);
});
test('callback retry repairs ledger after balance was durably credited, without crediting twice', async () => {
  const s = setup(), order = await s.create();
  s.db.failOnce(name => name === 'wallet_transactions');
  await assert.rejects(s.send(s.fields(order)), /simulated storage failure/);
  assert.equal(await s.balance(), 1000);
  await s.send(s.fields(order));
  assert.equal(await s.balance(), 1000);
  assert.equal((await s.db.collection('wallet_transactions').find({}).toArray()).length, 1);
});
test('authenticated gateway query recovers a lost callback and browser return alone cannot credit', async () => {
  const s = setup(), order = await s.create(); let output;
  await serveCardWallet({ method: 'GET' }, { setHeader() {}, json(v) { output = v; } }, { ...s, path: `wallet/card/${order.id}`, fetchImpl: async (url, o) => {
    assert.equal(url, 'https://secure-jordan.paytabs.com/payment/query'); assert.equal(JSON.parse(o.body).tran_ref, order.tran_ref);
    return Response.json(s.fields(order));
  } });
  assert.equal(output.order.status, 'approved'); assert.equal(await s.balance(), 1000);
  const instance = await startPlatformServer({ port: 0, database: s.db });
  try {
    const origin = `http://127.0.0.1:${instance.httpServer.address().port}`;
    const response = await fetch(`${origin}/api/payments/card/return?order=${order.id}`, { method: 'POST', redirect: 'manual', body: 'respStatus=A' });
    assert.equal(response.status, 303); assert.ok(response.headers.get('location').includes('card=return'));
    assert.equal(await s.balance(), 1000);
    assert.equal((await fetch(`${origin}/api/payments/card/callback`)).status, 405);
    assert.equal((await fetch(`${origin}/api/payments/card/callback`, { method: 'POST', body: '{}' })).status, 415);
  } finally { await new Promise(resolve => instance.io.close(() => instance.httpServer.close(resolve))); }
});
