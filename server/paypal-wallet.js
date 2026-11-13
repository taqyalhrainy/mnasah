import crypto from 'node:crypto';
import net from 'node:net';
import { paymentReturnOrigin } from '../shared/deployment.js';

// Payments Standard uses no API credentials. Readiness describes configuration,
// not merchant eligibility or availability of PayPal's guest card checkout.
const DEFAULT_EMAIL = 'takee12345678900@gmail.com';
const DEFAULT_ORIGIN = 'https://emtidad-alelm.onrender.com';
const ENDPOINTS = {
  live: { checkout: 'https://www.paypal.com/cgi-bin/webscr', verify: 'https://ipnpb.paypal.com/cgi-bin/webscr' },
  sandbox: { checkout: 'https://www.sandbox.paypal.com/cgi-bin/webscr', verify: 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr' },
};
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const duplicate = error => error?.code === 11000;
const indexes = new WeakMap();
const money = cents => (cents / 100).toFixed(2);
const secretEqual = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function config(env = process.env) {
  const mode = env.PAYPAL_MODE ?? 'live';
  const email = (env.PAYPAL_RECEIVER_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  const rate = env.PAYPAL_JOD_PER_USD ?? '0.709';
  let origin;
  try {
    const url = new URL(env.PAYPAL_PUBLIC_ORIGIN ?? DEFAULT_ORIGIN);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      && !url.port && url.hostname.includes('.') && !net.isIP(url.hostname)
      && !/^(?:localhost|.*\.(?:localhost|local|internal|test))$/i.test(url.hostname)) origin = url.origin;
  } catch { /* Fail closed for a malformed configured origin. Never derive it from Host. */ }
  const validRate = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(rate) && Number(rate) >= 0.01 && Number(rate) <= 100;
  const ready = Boolean(ENDPOINTS[mode] && origin && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && validRate);
  return { mode, email, rate, origin, ready, jod_per_usd: validRate ? Number(rate) : 0 };
}

export function paypalSettings(env = process.env) {
  const { email, ready, jod_per_usd } = config(env);
  return { email, ready, jod_per_usd };
}

export function publicPaypalOrder(row) {
  return { id: row.id, amount: row.amount, usd_amount: money(row.usd_cents), currency: 'USD', jod_per_usd: row.jod_per_usd, status: row.status, created: row.created,
    ...(row.review_required ? { review_required: true } : {}) };
}

export async function ensurePaypalIndexes(db) {
  if (!indexes.has(db)) {
    const promise = Promise.all([
      db.collection('paypal_orders').createIndex({ id: 1 }, { unique: true }),
      db.collection('paypal_orders').createIndex({ user_id: 1, created: -1 }),
      // Permanent, no TTL: a transaction can never be assigned to another order.
      db.collection('paypal_transactions').createIndex({ mode: 1, txn_id: 1 }, { unique: true }),
      db.collection('paypal_events').createIndex({ mode: 1, txn_id: 1, status: 1 }, { unique: true }),
      db.collection('wallet_accounts').createIndex({ user_id: 1 }, { unique: true }),
      db.collection('wallet_transactions').createIndex({ reference: 1 }, { unique: true, sparse: true }),
    ]).catch(error => { indexes.delete(db); throw error; });
    indexes.set(db, promise);
  }
  await indexes.get(db);
}

export async function servePaypalWallet(req, res, { db, user, path, validOrigin }) {
  if (path !== 'wallet/paypal' && !/^wallet\/paypal\/[^/]+$/.test(path)) return false;
  if (user.role !== 'students') fail(403, 'هذا القسم متاح للطلاب فقط.');
  res.setHeader('Cache-Control', 'no-store');
  if (path !== 'wallet/paypal') {
    if (req.method !== 'GET') fail(405, 'طريقة الطلب غير متاحة.');
    const order = await db.collection('paypal_orders').findOne({ id: path.split('/')[2], user_id: user.id });
    if (!order) fail(404, 'طلب الشحن غير موجود.');
    res.json({ order: publicPaypalOrder(order) });
    return true;
  }
  if (req.method !== 'POST') fail(405, 'طريقة الطلب غير متاحة.');
  if (!validOrigin) fail(403, 'مصدر الطلب غير صالح.');
  if ((await db.collection('wallet_accounts').findOne({ user_id: user.id }))?.paypal_review) fail(409, 'المحفظة قيد المراجعة. يرجى التواصل مع الإدارة قبل الشحن.');
  const settings = config();
  if (!settings.ready) fail(503, 'خدمة PayPal غير جاهزة حالياً.');
  const input = req.body?.amount;
  if (!['string', 'number'].includes(typeof input) || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(String(input))) fail(400, 'أدخل مبلغاً صحيحاً بمنزلتين عشريتين كحد أقصى.');
  const [whole, fraction = ''] = String(input).split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (amount < 100 || amount > 1000000) fail(400, 'أدخل مبلغاً بين 1 و10,000 دينار.');
  const [rateWhole, rateFraction = ''] = settings.rate.split('.');
  const scale = 10n ** BigInt(rateFraction.length);
  const numerator = BigInt(rateWhole + rateFraction);
  // Integer ceiling avoids float errors and never undercharges the fixed quote.
  const usd_cents = Number((BigInt(amount) * scale + numerator - 1n) / numerator);
  const order = { id: crypto.randomUUID(), nonce: crypto.randomBytes(32).toString('hex'), user_id: user.id,
    amount, usd_cents, receiver: settings.email, mode: settings.mode, jod_per_usd: settings.jod_per_usd,
    status: 'pending', created: Date.now() };
  await ensurePaypalIndexes(db);
  await db.collection('paypal_orders').insertOne(order);
  const checkout = new URL(ENDPOINTS[settings.mode].checkout);
  const returnOrigin = paymentReturnOrigin(req, settings.origin);
  checkout.search = new URLSearchParams({ cmd: '_xclick', business: order.receiver, amount: money(usd_cents), currency_code: 'USD',
    item_name: 'Student wallet top-up', invoice: order.id, custom: order.nonce, no_shipping: '1', no_note: '1', charset: 'utf-8',
    landing_page: 'Billing', shipping: '0.00', handling: '0.00', tax: '0.00', notify_url: `${settings.origin}/api/payments/paypal/ipn`,
    return: `${returnOrigin}/students?view=wallet&paypal=return&order=${order.id}`,
    cancel_return: `${returnOrigin}/students?view=wallet&paypal=cancel&order=${order.id}`, rm: '1' }).toString();
  res.json({ checkout_url: checkout.href, order: publicPaypalOrder(order) });
  return true;
}

function ipnCents(value) {
  if (!/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value || '')) return NaN;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1);
}

async function reserveTxn(db, mode, txn_id, order_id) {
  const collection = db.collection('paypal_transactions');
  try { await collection.updateOne({ mode, txn_id }, { $setOnInsert: { mode, txn_id, order_id, created: Date.now() } }, { upsert: true }); }
  catch (error) { if (!duplicate(error)) throw error; }
  if ((await collection.findOne({ mode, txn_id }))?.order_id !== order_id) fail(400, 'معاملة PayPal مرتبطة بطلب آخر.');
}

async function upsertLedger(db, entry) {
  try { await db.collection('wallet_transactions').updateOne({ reference: entry.reference }, { $setOnInsert: entry }, { upsert: true }); }
  catch (error) {
    if (!duplicate(error) || !await db.collection('wallet_transactions').findOne({ reference: entry.reference, user_id: entry.user_id, amount: entry.amount })) throw error;
  }
}

async function freezeReview(db, order, eventKey) {
  const token = crypto.createHash('sha256').update(eventKey).digest('hex');
  await db.collection('wallet_accounts').updateOne({ user_id: order.user_id, [`paypal_review_events.${token}`]: { $ne: true } }, {
    $inc: { paypal_review_version: 1 }, $set: { paypal_review: true, [`paypal_review_events.${token}`]: true,
      [`paypal.${order.id}.review`]: true, [`paypal.${order.id}.resolved`]: false, updated: Date.now() },
  });
}

export async function paypalReviews(db) {
  const accounts = await db.collection('wallet_accounts').find({ paypal_review: true }).limit(2000).toArray();
  return Promise.all(accounts.map(async account => ({ user_id: account.user_id, balance: account.balance, version: account.paypal_review_version,
    orders: (await db.collection('paypal_orders').find({ user_id: account.user_id, id: { $in: Object.entries(account.paypal || {}).filter(([, marker]) => marker.review && !marker.resolved).map(([id]) => id) } }).limit(100).toArray()).map(row => ({ ...publicPaypalOrder(row), review_required: true })) })));
}

// Owner reconciliation is explicit, evidenced and idempotent. The signed amount
// is the net JOD-cent correction confirmed against PayPal, including any refund
// or restored reversal. Reviewed orders never later auto-credit a delayed IPN.
export async function resolvePaypalReview(db, studentId, body, actor, audit) {
  const { reference, version, amount, evidence } = body || {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference || '')
    || !Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(amount) || Math.abs(amount) > 1000000
    || typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 2000) fail(400, 'أدخل مرجعاً فريداً وإصدار المراجعة وتصحيح الرصيد بالسنتات ودليل المطابقة مع PayPal.');
  await ensurePaypalIndexes(db);
  await reserveTxn(db, 'review', reference, studentId);
  const accounts = db.collection('wallet_accounts');
  let account = await accounts.findOne({ user_id: studentId });
  if (!account) fail(404, 'المحفظة غير موجودة.');
  const digest = crypto.createHash('sha256').update(JSON.stringify({ version, amount, evidence, actor })).digest('hex');
  const markerKey = `paypal_resolutions.${reference}`;
  if (!account.paypal_resolutions?.[reference]) {
    const order_ids = Object.entries(account.paypal || {}).filter(([, marker]) => marker.review && !marker.resolved).map(([id]) => id);
    const resolution = { reference, version, amount, evidence, actor, digest, order_ids, created: Date.now() };
    const set = { [markerKey]: resolution, paypal_review: false, updated: Date.now() };
    for (const id of order_ids) set[`paypal.${id}.resolved`] = true;
    await accounts.updateOne({ user_id: studentId, paypal_review: true, paypal_review_version: version, [markerKey]: { $exists: false } },
      { $inc: { balance: amount }, $set: set });
    account = await accounts.findOne({ user_id: studentId });
  }
  const saved = account.paypal_resolutions?.[reference];
  if (!saved || saved.digest !== digest) fail(409, 'تغيرت المراجعة أو استُخدم المرجع سابقاً. حدّث البيانات وحاول مجدداً.');
  await upsertLedger(db, { id: `paypal-review:${reference}`, reference: `paypal-review:${reference}`, user_id: studentId,
    type: 'paypal_refund', amount: saved.amount, note: saved.evidence, reviewed_by: saved.actor, created: saved.created });
  for (const id of saved.order_ids) {
    // Only clear a projection if no newer event has re-opened this order.
    const latest = await accounts.findOne({ user_id: studentId });
    if (latest.paypal?.[id]?.resolved) await db.collection('paypal_orders').updateOne({ id }, { $set: { review_required: false, status: 'refunded' } });
  }
  if (!saved.notified) {
    await audit(actor, 'wallet:paypal-review-resolved', JSON.stringify({ student_id: studentId, reference, amount, evidence }));
    await accounts.updateOne({ user_id: studentId }, { $set: { [`${markerKey}.notified`]: true } });
  }
  return { ok: true, balance: (await accounts.findOne({ user_id: studentId })).balance };
}

// Account markers and balance mutate in ONE Mongo document. The ledger and order
// are projections repaired on retry. Never roll back an increment on ledger error:
// another request may already have observed/spent it. Do not expire these markers.
async function reconcile(db, order, audit) {
  const account = await db.collection('wallet_accounts').findOne({ user_id: order.user_id });
  const marker = account?.paypal?.[order.id] || {};
  for (const [flag, type, amount, suffix] of [
    ['credited', 'paypal_topup', order.amount, 'credit'], ['debited', 'paypal_refund', -order.amount, 'refund'],
  ]) {
    if (!marker[flag]) continue;
    await upsertLedger(db, { id: `paypal:${order.id}:${suffix}`, user_id: order.user_id, type, amount,
      reference: `paypal:${order.id}:${suffix}`, created: order.created, paypal_order_id: order.id });
  }
  if (marker.reversed) await db.collection('paypal_orders').updateOne({ id: order.id }, { $set: { status: 'refunded' } });
  else if (marker.credited) await db.collection('paypal_orders').updateOne({ id: order.id, status: { $ne: 'refunded' } }, { $set: { status: 'approved' } });
  if (marker.resolved) await db.collection('paypal_orders').updateOne({ id: order.id }, { $set: { review_required: false, status: 'refunded' } });
  const current = await db.collection('paypal_orders').findOne({ id: order.id });
  if (marker.credited && !current.credit_notified) {
    // At-least-once owner notification: a crash may duplicate the audit, never the credit.
    await audit(order.user_id, 'wallet:paypal-topup', order.id);
    await db.collection('paypal_orders').updateOne({ id: order.id }, { $set: { credit_notified: true } });
  }
}

export async function processPaypalIpn(raw, { db, walletAccount, audit, fetchImpl = globalThis.fetch, env = process.env }) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 65536) fail(400, 'إشعار PayPal غير صالح.');
  const settings = config(env);
  if (!ENDPOINTS[settings.mode]) fail(503, 'إعداد PayPal غير صالح.');
  const fields = new URLSearchParams(raw.toString('utf8'));
  const seen = new Set();
  for (const [key] of fields) {
    if (seen.has(key) || key === 'cmd') fail(400, 'إشعار PayPal غير صالح.');
    seen.add(key);
  }
  if (settings.mode === 'live' && fields.has('test_ipn')) fail(400, 'إشعارات الاختبار غير متاحة هنا.');
  let verified;
  try {
    // Keep every byte, escaping and field order intact; do not serialize fields.
    const response = await fetchImpl(ENDPOINTS[settings.mode].verify, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
      body: Buffer.concat([Buffer.from('cmd=_notify-validate&'), raw]), signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail(503, 'تعذر التحقق من PayPal حالياً.');
    verified = (await response.text()).trim();
  } catch { fail(503, 'تعذر التحقق من PayPal حالياً.'); }
  if (verified === 'INVALID') fail(400, 'إشعار PayPal غير موثوق.');
  if (verified !== 'VERIFIED') fail(503, 'تعذر التحقق من PayPal حالياً.');
  await ensurePaypalIndexes(db);
  const value = key => fields.get(key) || '';
  const status = value('payment_status');
  const refund = ['Refunded', 'Reversed', 'Canceled_Reversal'].includes(status);
  const txn = value('txn_id'), parent = value('parent_txn_id');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(txn) || (refund && !/^[A-Za-z0-9_-]{1,64}$/.test(parent))) fail(400, 'رقم معاملة PayPal غير صالح.');
  let order = value('invoice') ? await db.collection('paypal_orders').findOne({ id: value('invoice') }) : null;
  if (!order && refund) {
    const original = await db.collection('paypal_transactions').findOne({ mode: settings.mode, txn_id: parent });
    if (original) order = await db.collection('paypal_orders').findOne({ id: original.order_id });
  }
  // Unknown refunds must retry: the original Completed can arrive later.
  if (!order) fail(refund ? 503 : 400, 'طلب شحن PayPal غير موجود.');
  if (order.mode !== settings.mode || value('receiver_email').toLowerCase() !== order.receiver || value('mc_currency') !== 'USD') fail(400, 'بيانات مستلم PayPal أو العملة غير مطابقة.');
  if ((!refund || value('invoice')) && value('invoice') !== order.id) fail(400, 'طلب PayPal غير مطابق.');
  if ((!refund || value('custom')) && !secretEqual(value('custom'), order.nonce)) fail(400, 'رمز طلب PayPal غير مطابق.');
  const gross = ipnCents(value('mc_gross'));
  if (!refund && (value('txn_type') !== 'web_accept' || gross !== order.usd_cents)) fail(400, 'مبلغ PayPal أو نوع المعاملة غير مطابق.');
  if (refund && (!Number.isFinite(gross) || (status !== 'Canceled_Reversal' && (gross >= 0 || -gross > order.usd_cents)))) fail(400, 'مبلغ الاسترداد غير مطابق.');

  // Initialize BEFORE any ledger entry; legacy walletAccount derives balance from it.
  try { await walletAccount(order.user_id); } catch (error) { if (!duplicate(error)) throw error; }
  const accounts = db.collection('wallet_accounts');
  const key = `paypal.${order.id}`; // server UUID, never an untrusted dotted Mongo key
  if (refund) {
    await reserveTxn(db, order.mode, parent, order.id);
    await reserveTxn(db, order.mode, txn, order.id);
    await db.collection('paypal_orders').updateOne({ id: order.id, $or: [{ credit_txn_id: { $exists: false } }, { credit_txn_id: parent }] }, { $set: { credit_txn_id: parent } });
    const boundOrder = await db.collection('paypal_orders').findOne({ id: order.id });
    // Refunds sometimes omit invoice/custom/txn_type; the permanent parent binding
    // authenticates their order. An out-of-order refund with pass-through fields
    // can reserve that binding before Completed arrives.
    const accountBefore = await accounts.findOne({ user_id: order.user_id });
    const priorEvent = await db.collection('paypal_events').findOne({ mode: order.mode, txn_id: txn, status });
    const review = priorEvent ? priorEvent.review_required : status === 'Canceled_Reversal' || -gross !== order.usd_cents || boundOrder.credit_txn_id !== parent || Boolean(accountBefore?.paypal?.[order.id]?.resolved);
    try {
      await db.collection('paypal_events').updateOne({ mode: order.mode, txn_id: txn, status }, { $setOnInsert: {
        mode: order.mode, txn_id: txn, status, order_id: order.id, parent_txn_id: parent, gross, review_required: review, created: Date.now(),
      } }, { upsert: true });
    } catch (error) { if (!duplicate(error)) throw error; }
    await db.collection('paypal_orders').updateOne({ id: order.id }, { $set: { status: 'refunded', ...(review ? { review_required: true } : {}) } });
    if (review) {
      // Do not guess how multiple partial refunds or a canceled reversal net out.
      // Freeze spending AND new PayPal credits until the owner reconciles PayPal.
      await freezeReview(db, order, `${order.mode}:${txn}:${status}`);
    } else {
      // A refund racing Completed either debits its credit or prevents it entirely.
      // Both conditional operations are monotonic, atomic and safe to replay.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await accounts.updateOne({ user_id: order.user_id, [`${key}.credited`]: true, [`${key}.reversed`]: { $ne: true } },
          { $inc: { balance: -order.amount }, $set: { [`${key}.reversed`]: true, [`${key}.debited`]: true, updated: Date.now() } });
        await accounts.updateOne({ user_id: order.user_id, [`${key}.credited`]: { $ne: true }, [`${key}.reversed`]: { $ne: true } },
          { $set: { [`${key}.reversed`]: true, updated: Date.now() } });
        if ((await accounts.findOne({ user_id: order.user_id }))?.paypal?.[order.id]?.reversed) break;
        if (attempt === 3) fail(503, 'تعذر تحديث المحفظة حالياً.');
      }
    }
    await reconcile(db, order, audit);
    const event = { mode: order.mode, txn_id: txn, status };
    if (!(await db.collection('paypal_events').findOne(event)).notified) {
      await audit(order.user_id, review ? 'wallet:paypal-review' : 'wallet:paypal-refund', order.id);
      await db.collection('paypal_events').updateOne(event, { $set: { notified: true } });
    }
    return;
  }
  if (status === 'Completed') {
    await reserveTxn(db, order.mode, txn, order.id);
    await db.collection('paypal_orders').updateOne({ id: order.id, $or: [{ credit_txn_id: { $exists: false } }, { credit_txn_id: txn }] }, { $set: { credit_txn_id: txn } });
    order = await db.collection('paypal_orders').findOne({ id: order.id });
    if (order.credit_txn_id !== txn) {
      await freezeReview(db, order, `${order.mode}:${txn}:extra-payment`);
      await db.collection('paypal_orders').updateOne({ id: order.id }, { $set: { review_required: true } });
      await audit(order.user_id, 'wallet:paypal-review', order.id);
      return;
    }
    await accounts.updateOne({ user_id: order.user_id, paypal_review: { $ne: true }, [`${key}.review`]: { $ne: true }, [`${key}.credited`]: { $ne: true }, [`${key}.reversed`]: { $ne: true } },
      { $inc: { balance: order.amount }, $set: { [`${key}.credited`]: true, updated: Date.now() } });
    await reconcile(db, order, audit);
    const account = await accounts.findOne({ user_id: order.user_id });
    // A frozen, uncredited Completed must remain retryable (never ACK and lose it).
    if (!account?.paypal?.[order.id]?.credited && !account?.paypal?.[order.id]?.reversed && !account?.paypal?.[order.id]?.resolved) fail(503, 'المحفظة قيد المراجعة.');
  } else if (['Denied', 'Failed', 'Expired', 'Voided'].includes(status)) {
    await db.collection('paypal_orders').updateOne({ id: order.id, status: 'pending', credit_txn_id: { $exists: false } }, { $set: { status: 'rejected' } });
  }
  // Pending, unknown statuses and browser return/cancel never credit funds.
}
