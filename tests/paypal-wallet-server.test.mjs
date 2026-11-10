import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { paypalSettings, servePaypalWallet, processPaypalIpn, resolvePaypalReview, paypalReviews } from '../server/paypal-wallet.js';
import { startPlatformServer } from '../server/index.js';

// Atomic document mutations, dotted fields and unique indexes model Mongo's
// actual guarantees. Failpoints exercise recovery between durable writes.
function paymentDb() {
  const data = new Map(), indexes = new Map();
  let fault;
  const get = (row, key) => key.split('.').reduce((v, k) => v?.[k], row);
  const set = (row, key, value) => { const keys = key.split('.'); const last = keys.pop(); for (const part of keys) row = row[part] ||= {}; row[last] = structuredClone(value); };
  const match = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => match(row, q));
    const current = get(row, key);
    if (value && typeof value === 'object') return Object.entries(value).every(([op, v]) => op === '$ne' ? current !== v : op === '$exists' ? (current !== undefined) === v : op === '$in' ? v.includes(current) : op === '$gte' ? current >= v : op === '$gt' ? current > v : op === '$lt' ? current < v : op === '$lte' ? current <= v : (() => { throw new Error(op); })());
    return current === value;
  });
  const collection = name => {
    if (!data.has(name)) data.set(name, []);
    const rows = data.get(name);
    const validate = (candidate, old) => { for (const index of indexes.get(name) || []) { const keys = Object.keys(index.keys); if (index.sparse && keys.every(k => get(candidate, k) === undefined)) continue; if (rows.some(row => row !== old && keys.every(k => get(row, k) === get(candidate, k)))) throw Object.assign(new Error('duplicate'), { code: 11000 }); } };
    return {
      async createIndex(keys, options = {}) { if (options.unique) { const list = indexes.get(name) || []; list.push({ keys, ...options }); indexes.set(name, list); } },
      async findOne(query = {}) { return structuredClone(rows.find(row => match(row, query)) || null); },
      find(query = {}) { let selected = rows.filter(row => match(row, query)); const cursor = { sort(order) { selected.sort((a, b) => { for (const [key, direction] of Object.entries(order)) if (get(a, key) !== get(b, key)) return (get(a, key) > get(b, key) ? 1 : -1) * direction; return 0; }); return cursor; }, limit(n) { selected = selected.slice(0, n); return cursor; }, async toArray() { return structuredClone(selected); } }; return cursor; },
      async insertOne(row) { validate(row); rows.push(structuredClone(row)); },
      async updateOne(query, update, options = {}) {
        if (fault?.(name, query, update)) { fault = undefined; throw new Error('simulated storage failure'); }
        const old = rows.find(row => match(row, query));
        if (!old && !options.upsert) return { modifiedCount: 0 };
        const row = old ? structuredClone(old) : { ...structuredClone(query), ...structuredClone(update.$setOnInsert || {}) };
        for (const [key, value] of Object.entries(update.$set || {})) set(row, key, value);
        for (const [key, value] of Object.entries(update.$inc || {})) set(row, key, Number(get(row, key) || 0) + value);
        validate(row, old);
        if (old) Object.assign(old, row); else rows.push(row);
        return { modifiedCount: 1, upsertedCount: old ? 0 : 1 };
      },
      async deleteOne(query) { const i = rows.findIndex(row => match(row, query)); if (i >= 0) rows.splice(i, 1); },
    };
  };
  return { collection, failOnce(predicate) { fault = predicate; } };
}

const user = { id: 'paypal-student', role: 'students', status: 'active', name: 'Student' };
const env = { PAYPAL_MODE: 'live', PAYPAL_RECEIVER_EMAIL: 'takee12345678900@gmail.com', PAYPAL_JOD_PER_USD: '0.709', PAYPAL_PUBLIC_ORIGIN: 'https://emtidad-alelm.onrender.com' };
function setup() {
  const db = paymentDb(), audits = [];
  const walletAccount = async id => {
    let row = await db.collection('wallet_accounts').findOne({ user_id: id });
    if (!row) { const ledger = await db.collection('wallet_transactions').find({ user_id: id }).toArray(); await db.collection('wallet_accounts').updateOne({ user_id: id }, { $setOnInsert: { user_id: id, balance: ledger.reduce((sum, entry) => sum + entry.amount, 0) } }, { upsert: true }); row = await db.collection('wallet_accounts').findOne({ user_id: id }); }
    return row;
  };
  const audit = async (...args) => { audits.push(args); };
  const process = (raw, extra = {}) => processPaypalIpn(Buffer.isBuffer(raw) ? raw : Buffer.from(new URLSearchParams(raw).toString()), { db, walletAccount, audit, env, fetchImpl: async () => new Response('VERIFIED'), ...extra });
  const balance = async () => (await walletAccount(user.id)).balance;
  const create = async (amount = '10.00', options = {}) => { let output; await servePaypalWallet({ method: 'POST', body: { amount } }, { setHeader() {}, json(value) { output = value; } }, { db, user, path: 'wallet/paypal', validOrigin: true, ...options }); const row = await db.collection('paypal_orders').findOne({ id: output.order.id }); return { output, row }; };
  const fields = (row, extra = {}) => ({ invoice: row.id, custom: row.nonce, receiver_email: row.receiver, mc_currency: 'USD', mc_gross: (row.usd_cents / 100).toFixed(2), payment_status: 'Completed', txn_type: 'web_accept', txn_id: 'TXN_1', ...extra });
  return { db, audits, walletAccount, audit, process, balance, create, fields };
}
const rejects = (promise, status) => assert.rejects(promise, error => status === undefined || error.status === status);

test('PayPal quote, configuration, origin, ownership and public data', async () => {
  const s = setup(), { output, row } = await s.create();
  assert.equal(output.order.usd_amount, '14.11'); assert.equal(output.order.amount, 1000);
  const url = new URL(output.checkout_url);
  assert.equal(url.origin, 'https://www.paypal.com'); assert.equal(url.searchParams.get('business'), env.PAYPAL_RECEIVER_EMAIL);
  assert.equal(url.searchParams.get('notify_url'), `${env.PAYPAL_PUBLIC_ORIGIN}/api/payments/paypal/ipn`);
  assert.ok(!('nonce' in output.order)); assert.equal(await s.balance(), 0);
  assert.equal((await s.create('1')).output.order.usd_amount, '1.42');
  for (const amount of ['0', '-1', '1.001', '1e2', '10001', 'abc', {}, null]) await rejects(s.create(amount), 400);
  await rejects(s.create('10', { validOrigin: false }), 403);
  await rejects(s.create('10', { user: { ...user, role: 'teachers' } }), 403);
  await rejects(servePaypalWallet({ method: 'GET' }, { setHeader() {}, json() {} }, { db: s.db, user: { ...user, id: 'other' }, path: `wallet/paypal/${row.id}` }), 404);
  for (const origin of ['http://evil.com', 'https://example.com/path', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://x.local']) assert.equal(paypalSettings({ ...env, PAYPAL_PUBLIC_ORIGIN: origin }).ready, false);
  assert.equal(paypalSettings({ ...env, PAYPAL_JOD_PER_USD: '0' }).ready, false);
});

test('PayPal verifier preserves raw bytes, fixed endpoints, rejects forged data and waits for Completed', async () => {
  const s = setup(), { row } = await s.create();
  const raw = Buffer.from(new URLSearchParams({ ...s.fields(row), memo: 'a+b & x=y', payment_status: 'Pending' }).toString());
  await s.process(raw, { fetchImpl: async (url, options) => { assert.equal(url, 'https://ipnpb.paypal.com/cgi-bin/webscr'); assert.deepEqual(options.body, Buffer.concat([Buffer.from('cmd=_notify-validate&'), raw])); assert.equal(options.redirect, 'error'); return new Response('VERIFIED'); } });
  assert.equal(await s.balance(), 0);
  for (const replacement of [{ receiver_email: 'thief@example.com' }, { mc_currency: 'EUR' }, { mc_gross: '0.01' }, { custom: 'wrong' }, { invoice: 'missing' }, { txn_type: 'subscr_payment' }, { test_ipn: '1' }]) await rejects(s.process(s.fields(row, replacement)), 400);
  await rejects(s.process(s.fields(row), { fetchImpl: async () => new Response('INVALID') }), 400);
  await rejects(s.process(s.fields(row), { fetchImpl: async () => new Response('UNEXPECTED') }), 503);
  await rejects(s.process(s.fields(row), { fetchImpl: async () => { throw new Error('offline'); } }), 503);
  await rejects(s.process(Buffer.from('txn_id=a&txn_id=b')), 400);
  await rejects(s.process(Buffer.alloc(65537, 120)), 400);
  assert.equal(await s.balance(), 0);
});

test('duplicate/concurrent callbacks credit once and a transaction cannot credit another order', async () => {
  const s = setup(), { row } = await s.create();
  await Promise.all(Array.from({ length: 16 }, () => s.process(s.fields(row))));
  assert.equal(await s.balance(), 1000);
  assert.equal((await s.db.collection('wallet_transactions').find({}).toArray()).length, 1);
  assert.equal((await s.db.collection('paypal_orders').findOne({ id: row.id })).status, 'approved');
  const other = (await s.create()).row;
  await rejects(s.process(s.fields(other)), 400); assert.equal(await s.balance(), 1000);
});

test('sandbox verification stays isolated and legacy ledger balances are not counted twice', async () => {
  const s = setup(), { row } = await s.create();
  await s.db.collection('wallet_transactions').insertOne({ id: 'old-credit', user_id: user.id, amount: 300, reference: 'old-credit' });
  await s.db.collection('paypal_orders').updateOne({ id: row.id }, { $set: { mode: 'sandbox' } });
  await s.process(s.fields(row, { test_ipn: '1' }), { env: { ...env, PAYPAL_MODE: 'sandbox' }, fetchImpl: async url => { assert.equal(url, 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'); return new Response('VERIFIED'); } });
  assert.equal(await s.balance(), 1300);
});

test('storage failures between credit, ledger, projection and notification recover without rollback or double credit', async () => {
  for (const phase of ['ledger', 'projection', 'notification']) {
    const s = setup(), { row } = await s.create(); let auditFailed = false;
    if (phase !== 'notification') s.db.failOnce((name, _query, update) => phase === 'ledger' ? name === 'wallet_transactions' : name === 'paypal_orders' && update.$set?.status === 'approved');
    const options = phase === 'notification' ? { audit: async (...args) => { if (!auditFailed) { auditFailed = true; throw new Error('audit offline'); } await s.audit(...args); } } : {};
    await rejects(s.process(s.fields(row), options));
    assert.equal(await s.balance(), 1000, phase);
    await s.process(s.fields(row), options); await s.process(s.fields(row), options);
    assert.equal(await s.balance(), 1000); assert.equal((await s.db.collection('wallet_transactions').find({}).toArray()).length, 1);
    assert.equal((await s.db.collection('paypal_orders').findOne({ id: row.id })).status, 'approved');
  }
});

test('full refunds are idempotent, survive spent funds and can precede Completed', async () => {
  for (const before of [false, true]) {
    const s = setup(), { row } = await s.create();
    const refund = s.fields(row, { payment_status: 'Refunded', txn_id: 'REFUND_1', parent_txn_id: 'TXN_1', mc_gross: '-14.11' });
    if (!before) { await s.process(s.fields(row)); await s.db.collection('wallet_accounts').updateOne({ user_id: user.id }, { $inc: { balance: -800 } }); }
    await Promise.all([s.process(refund), s.process(refund)]);
    await s.process(s.fields(row)); await s.process(refund);
    await s.process({ ...refund, invoice: '', custom: '' });
    assert.equal(await s.balance(), before ? 0 : -800);
    assert.equal((await s.db.collection('paypal_orders').findOne({ id: row.id })).status, 'refunded');
  }
});

test('partial refund review blocks new charges, owner resolution is evidenced, versioned and idempotent', async () => {
  const s = setup(), { row } = await s.create(); await s.process(s.fields(row));
  const partial = s.fields(row, { payment_status: 'Refunded', txn_id: 'PARTIAL_1', parent_txn_id: 'TXN_1', mc_gross: '-7.05' });
  await s.process(partial); assert.equal((await s.walletAccount(user.id)).paypal_review, true);
  await rejects(s.create(), 409);
  const review = (await paypalReviews(s.db))[0]; assert.equal(review.orders[0].id, row.id);
  const body = { reference: crypto.randomUUID(), version: review.version, amount: -500, evidence: 'PayPal PARTIAL_1 refund checked by owner' };
  await rejects(resolvePaypalReview(s.db, user.id, { ...body, evidence: '' }, 'admin', s.audit), 400);
  await rejects(resolvePaypalReview(s.db, user.id, { ...body, version: body.version + 1, reference: crypto.randomUUID() }, 'admin', s.audit), 409);
  s.db.failOnce(name => name === 'wallet_transactions');
  await rejects(resolvePaypalReview(s.db, user.id, body, 'admin', s.audit));
  assert.equal(await s.balance(), 500, 'a ledger failure cannot reverse an already visible correction');
  await resolvePaypalReview(s.db, user.id, body, 'admin', s.audit);
  assert.equal(await s.balance(), 500); assert.equal((await s.walletAccount(user.id)).paypal_review, false);
  await s.process(partial); await s.process(s.fields(row));
  assert.equal(await s.balance(), 500); assert.equal((await s.walletAccount(user.id)).paypal_review, false);
  assert.equal((await paypalReviews(s.db)).length, 0);
});

test('canceled reversals enter owner review and replay cannot freeze an already resolved wallet', async () => {
  const s = setup(), { row } = await s.create(); await s.process(s.fields(row));
  const reversed = s.fields(row, { payment_status: 'Reversed', parent_txn_id: 'TXN_1', txn_id: 'REVERSE_1', mc_gross: '-14.11' });
  await s.process(reversed); assert.equal(await s.balance(), 0);
  const canceled = s.fields(row, { payment_status: 'Canceled_Reversal', parent_txn_id: 'TXN_1', txn_id: 'RESTORE_1', mc_gross: '14.11' });
  await s.process(canceled);
  const review = (await paypalReviews(s.db))[0];
  await resolvePaypalReview(s.db, user.id, { version: review.version, amount: 1000, reference: crypto.randomUUID(), evidence: 'RESTORE_1 confirmed restored money in PayPal' }, 'admin', s.audit);
  await s.process(canceled); assert.equal(await s.balance(), 1000); assert.equal((await s.walletAccount(user.id)).paypal_review, false);
});

test('HTTP authentication, callback parser and owner/public portal routing', async t => {
  const s = setup(), now = Date.now();
  await s.db.collection('users').insertOne(user);
  await s.db.collection('sessions').insertOne({ user_id: user.id, token: crypto.createHash('sha256').update('paypal-http').digest('hex'), expires: now + 3600000 });
  const { httpServer, io } = await startPlatformServer({ database: s.db, port: 0, portalMode: 'public' });
  t.after(() => new Promise(resolve => io.close(() => httpServer.close(resolve))));
  const base = `http://127.0.0.1:${httpServer.address().port}`, cookie = 'mansah_session_students=paypal-http';
  assert.equal((await fetch(`${base}/api/students/wallet/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"amount":"10"}' })).status, 401);
  assert.equal((await fetch(`${base}/api/students/wallet/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' }, body: '{"amount":"10"}' })).status, 403);
  const response = await fetch(`${base}/api/students/wallet/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base }, body: '{"amount":"10"}' });
  assert.equal(response.status, 200); const order = await response.json(); assert.equal(order.order.usd_amount, '14.11');
  assert.equal((await fetch(`${base}/api/payments/paypal/ipn`)).status, 405);
  assert.equal((await fetch(`${base}/api/payments/paypal/ipn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/payments/paypal/ipn`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'test_ipn=1' })).status, 400);
  assert.equal((await fetch(`${base}/api/payments/paypal/ipn`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(65537) })).status, 413);
  assert.equal(await s.balance(), 0);
  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = (url, options) => String(url) === 'https://ipnpb.paypal.com/cgi-bin/webscr' ? Promise.resolve(new Response('VERIFIED')) : nativeFetch(url, options);
    const stored = await s.db.collection('paypal_orders').findOne({ id: order.order.id });
    const callback = await nativeFetch(`${base}/api/payments/paypal/ipn`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(s.fields(stored)) });
    assert.equal(callback.status, 200); assert.equal(await s.balance(), 1000);
  } finally { globalThis.fetch = nativeFetch; }
});
