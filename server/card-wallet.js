import crypto from 'node:crypto';

const ORIGIN = 'https://emtidad-alelm.onrender.com';
const GATEWAY = 'https://secure-jordan.paytabs.com';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const duplicate = error => error?.code === 11000;
const indexes = new WeakMap();
function config(env = process.env) {
  const profile = String(env.PAYTABS_PROFILE_ID || '').trim();
  const key = String(env.PAYTABS_SERVER_KEY || '').trim();
  let origin;
  try { const u = new URL(env.PAYTABS_PUBLIC_ORIGIN || ORIGIN); if (u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && !u.port && u.hostname.endsWith('.onrender.com')) origin = u.origin; } catch {}
  // Explicit enablement requires an approved LIVE Jordan profile. A test profile
  // must never credit a real student's wallet.
  return { profile, key, origin, ready: env.PAYTABS_ENABLED === 'true' && /^\d{1,12}$/.test(profile) && key.length >= 16 && Boolean(origin) };
}
export const cardSettings = (env = process.env) => ({ provider: 'paytabs', currency: 'JOD', ready: config(env).ready });
export const publicCardOrder = row => ({ id: row.id, amount: row.amount, currency: 'JOD', status: row.status, created: row.created });
export async function ensureCardIndexes(db) {
  if (!indexes.has(db)) indexes.set(db, Promise.all([
    db.collection('card_orders').createIndex({ id: 1 }, { unique: true }),
    db.collection('card_orders').createIndex({ user_id: 1, created: -1 }),
    db.collection('card_events').createIndex({ tran_ref: 1 }, { unique: true }),
    db.collection('wallet_accounts').createIndex({ user_id: 1 }, { unique: true }),
    db.collection('wallet_transactions').createIndex({ reference: 1 }, { unique: true, sparse: true }),
  ]).catch(error => { indexes.delete(db); throw error; }));
  await indexes.get(db);
}
function cents(value) {
  if (!['string', 'number'].includes(typeof value) || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,3})?$/.test(String(value))) return NaN;
  const [whole, fraction = ''] = String(value).split('.');
  // Gateway JOD amounts have three decimals; our wallet supports two. Never round
  // a mismatched gateway amount into the amount we expected.
  if (fraction.length === 3 && fraction[2] !== '0') return NaN;
  return Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
}
async function gateway(path, body, settings, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${GATEWAY}/payment/${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: settings.key, 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: Number(settings.profile), ...body }) });
    if (!response.ok) throw new Error();
    return await response.json();
  } catch { fail(503, 'تعذر الاتصال ببوابة البطاقات. حاول مجدداً.'); }
}
function safeCheckout(value) {
  try { const u = new URL(value); return u.origin === GATEWAY && !u.username && !u.password && /^\/payment\/(page|wr)\//.test(u.pathname); } catch { return false; }
}
export async function serveCardWallet(req, res, { db, user, path, validOrigin, walletAccount, audit, env = process.env, fetchImpl = fetch }) {
  if (path !== 'wallet/card' && !/^wallet\/card\/[a-f0-9-]{36}$/.test(path)) return false;
  if (user.role !== 'students') fail(403, 'هذا القسم متاح للطلاب فقط.');
  res.setHeader('Cache-Control', 'no-store');
  const settings = config(env);
  if (path !== 'wallet/card') {
    if (req.method !== 'GET') fail(405, 'طريقة الطلب غير متاحة.');
    let order = await db.collection('card_orders').findOne({ id: path.split('/')[2], user_id: user.id });
    if (!order) fail(404, 'طلب الشحن غير موجود.');
    // Authenticated query also recovers lost server callbacks, never trust the
    // browser return status. Persist throttling before the remote request.
    if (settings.ready && order.tran_ref && order.profile === settings.profile && Date.now() - (order.queried || 0) > 15000 && order.status === 'pending') {
      const claim = await db.collection('card_orders').updateOne({ id: order.id, queried: order.queried || { $exists: false } }, { $set: { queried: Date.now() } });
      if (claim.modifiedCount) {
        const result = await gateway('query', { tran_ref: order.tran_ref }, settings, fetchImpl);
        await applyResult(result, { db, walletAccount, audit, settings });
        order = await db.collection('card_orders').findOne({ id: order.id });
      }
    }
    res.json({ order: publicCardOrder(order) }); return true;
  }
  if (req.method !== 'POST') fail(405, 'طريقة الطلب غير متاحة.');
  if (!validOrigin) fail(403, 'مصدر الطلب غير صالح.');
  if (!settings.ready) fail(503, 'الدفع بالبطاقة قيد التفعيل. استخدم كليك حالياً.');
  if ((await walletAccount(user.id)).paypal_review) fail(409, 'المحفظة قيد المراجعة. يرجى التواصل مع الإدارة قبل الشحن.');
  const amount = cents(req.body?.amount);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1000000 || /\.\d{3}$/.test(String(req.body?.amount))) fail(400, 'أدخل مبلغاً بين 1 و10,000 دينار بمنزلتين عشريتين كحد أقصى.');
  await ensureCardIndexes(db);
  const order = { id: crypto.randomUUID(), user_id: user.id, amount, profile: settings.profile, status: 'pending', created: Date.now() };
  await db.collection('card_orders').insertOne(order);
  const result = await gateway('request', {
    tran_type: 'sale', tran_class: 'ecom', cart_id: order.id, cart_currency: 'JOD', cart_amount: (amount / 100).toFixed(3),
    cart_description: 'Emtidad Al Elm - student wallet top-up', payment_methods: ['creditcard'],
    paypage_lang: req.body?.language === 'en' ? 'en' : 'ar', hide_shipping: true, show_save_card: false,
    customer_details: { ...(user.name ? { name: user.name } : {}), ...(user.email ? { email: user.email } : {}), ...(user.phone ? { phone: user.phone } : {}) },
    callback: `${settings.origin}/api/payments/card/callback`, return: `${settings.origin}/api/payments/card/return?order=${order.id}`,
  }, settings, fetchImpl);
  if (!safeCheckout(result.redirect_url) || !/^[A-Za-z0-9_-]{5,128}$/.test(result.tran_ref || '') || /^TST/i.test(result.tran_ref) || result.cart_id !== order.id) fail(502, 'تعذر تجهيز صفحة الدفع بالبطاقة.');
  await db.collection('card_orders').updateOne({ id: order.id }, { $set: { tran_ref: result.tran_ref } });
  res.json({ checkout_url: result.redirect_url, order: publicCardOrder(order) }); return true;
}

async function applyResult(result, { db, walletAccount, audit, settings }) {
  const order = await db.collection('card_orders').findOne({ id: result.cart_id });
  if (!order) return;
  if (order.profile !== settings.profile || (result.profile_id !== undefined && String(result.profile_id) !== settings.profile)) fail(400, 'بيانات الدفع غير متطابقة.');
  const type = String(result.tran_type || '').toLowerCase(), ref = result.tran_ref;
  const refund = type === 'refund';
  if (!['sale', 'refund'].includes(type) || String(result.tran_class || '').toLowerCase() !== 'ecom') return;
  if (!/^[A-Za-z0-9_-]{5,128}$/.test(ref || '') || /^TST/i.test(ref)) fail(400, 'بيانات الدفع غير متطابقة.');
  const status = result.payment_result?.response_status;
  if (status !== 'A') {
    if (!refund && ref === order.tran_ref && !result.previous_tran_ref && ['D', 'E', 'X'].includes(status)) await db.collection('card_orders').updateOne({ id: order.id, status: 'pending' }, { $set: { status: 'rejected' } });
    return; // Pending, hold, cancelled and declined never credit.
  }
  if (result.cart_currency !== 'JOD' || result.tran_currency !== 'JOD' || (!refund && cents(result.cart_amount) !== order.amount)) fail(400, 'مبلغ الدفع أو العملة غير متطابقين.');
  const amount = cents(result.tran_total);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > order.amount || (!refund && amount !== order.amount)) fail(400, 'مبلغ الدفع أو العملة غير متطابقين.');
  if (refund ? result.previous_tran_ref !== order.tran_ref : (result.previous_tran_ref || ref !== order.tran_ref)) fail(400, 'مرجع الدفع غير متطابق.');
  const event = { tran_ref: ref, order_id: order.id, amount, type, created: Date.now() };
  try { await db.collection('card_events').updateOne({ tran_ref: ref }, { $setOnInsert: event }, { upsert: true }); } catch (e) { if (!duplicate(e)) throw e; }
  const stored = await db.collection('card_events').findOne({ tran_ref: ref });
  if (stored.order_id !== order.id || stored.amount !== amount || stored.type !== type) fail(400, 'مرجع الدفع مستخدم مسبقاً.');
  await walletAccount(order.user_id);
  const key = `card.${order.id}`, eventKey = crypto.createHash('sha256').update(ref).digest('hex');
  // Compare-and-swap the balance and order markers in ONE wallet document. This
  // survives concurrent/reordered callbacks and crashes before ledger repair.
  for (let attempt = 0; attempt < 30; attempt++) {
    const account = await db.collection('wallet_accounts').findOne({ user_id: order.user_id });
    const old = account.card?.[order.id];
    if (old?.events?.[eventKey]) break;
    const next = { version: (old?.version || 0) + 1, paid: old?.paid || false, refunded: old?.refunded || 0, events: { ...old?.events, [eventKey]: true } };
    if (refund) next.refunded += amount; else next.paid = true;
    if (next.refunded > order.amount) fail(400, 'قيمة الاسترداد تتجاوز قيمة الدفعة.');
    const before = old?.paid ? order.amount - old.refunded : 0;
    const after = next.paid ? order.amount - next.refunded : 0;
    const update = await db.collection('wallet_accounts').updateOne({ user_id: order.user_id, [`${key}.version`]: old?.version ?? { $exists: false } }, { $inc: { balance: after - before }, $set: { [key]: next, updated: Date.now() } });
    if (update.modifiedCount) break;
    if (attempt === 29) fail(503, 'تعذر تأكيد الدفع حالياً.');
  }
  const marker = (await db.collection('wallet_accounts').findOne({ user_id: order.user_id })).card[order.id];
  // Ledger is a durable projection; retries fill any gaps without re-crediting.
  const events = await db.collection('card_events').find({ order_id: order.id }).toArray();
  for (const item of events) {
    if (!marker.paid) continue;
    if (!marker.events[crypto.createHash('sha256').update(item.tran_ref).digest('hex')]) continue;
    const reference = `paytabs:${item.tran_ref}`;
    try { await db.collection('wallet_transactions').updateOne({ reference }, { $setOnInsert: { id: crypto.randomUUID(), user_id: order.user_id, type: item.type === 'sale' ? 'card_topup' : 'card_refund', amount: item.type === 'sale' ? item.amount : -item.amount, reference, created: item.created } }, { upsert: true }); } catch (e) { if (!duplicate(e)) throw e; }
  }
  await db.collection('card_orders').updateOne({ id: order.id, $or: [{ projection_version: { $exists: false } }, { projection_version: { $lt: marker.version } }] }, { $set: { projection_version: marker.version, status: marker.refunded ? 'refunded' : marker.paid ? 'approved' : 'pending' } });
  if (!stored.notified) {
    await audit(order.user_id, refund ? 'wallet:card-refund' : 'wallet:card-topup', order.id);
    await db.collection('card_events').updateOne({ tran_ref: ref }, { $set: { notified: true } });
  }
}
export async function processCardCallback(raw, signature, { db, walletAccount, audit, env = process.env }) {
  const settings = config(env);
  if (!settings.ready) fail(503, 'الدفع بالبطاقة قيد التفعيل.');
  if (!Buffer.isBuffer(raw) || raw.length > 65536 || !/^[a-f0-9]{64}$/i.test(signature || '')) fail(403, 'توقيع الدفع غير صالح.');
  const expected = crypto.createHmac('sha256', settings.key).update(raw).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(403, 'توقيع الدفع غير صالح.');
  let result; try { result = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'بيانات الدفع غير صالحة.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'بيانات الدفع غير صالحة.');
  await ensureCardIndexes(db);
  await applyResult(result, { db, walletAccount, audit, settings });
}
