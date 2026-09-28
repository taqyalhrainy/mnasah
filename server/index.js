import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { MongoClient } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 8787);
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'mansah';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const OWNER_SETUP_TOKEN = process.env.OWNER_SETUP_TOKEN || 'local-testing-owner-token';

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Add it to .env before using the backend with real data.');
}

app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (!CLIENT_ORIGIN || CLIENT_ORIGIN.split(',').map(s => s.trim()).includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let db;
let client;
async function connect() {
  if (db) return db;
  if (!MONGODB_URI) fail(500, 'MongoDB غير مضبوط على الخادم.');
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(MONGODB_DB);
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ role: 1 }),
    db.collection('sessions').createIndex({ token: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
    db.collection('slots').createIndex({ teacher_id: 1, start: 1 }),
    db.collection('bookings').createIndex({ slot_id: 1 }),
    db.collection('bookings').createIndex({ student_id: 1 }),
    db.collection('messages').createIndex({ booking_id: 1, created: 1 }),
    db.collection('catalog').createIndex({ kind: 1, position: 1 }),
  ]);
  await seedCatalog();
  return db;
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function field(value, max = 200, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, 'تحقق من الحقول المطلوبة وطول النص.');
  return value.trim();
}
const random = () => crypto.randomBytes(32).toString('hex');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function passwordHash(value, salt = random()) {
  return `${salt}:${crypto.pbkdf2Sync(value, salt, 100000, 32, 'sha256').toString('hex')}`;
}
function equal(a = '', b = '') {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
const sessionCookie = role => ['admin', 'teachers', 'students'].includes(role) ? `mansah_session_${role}` : 'mansah_session';
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  return raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || '';
}
function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, subject: u.subject || '', bio: u.bio || '', academic_level: u.academic_level || '', phone: u.phone || '', mustChangePassword: Boolean(u.must_change_password) } : null;
}
function setSession(res, role, token, expires) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookie(role)}=${token}; Path=/; HttpOnly${secure}; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`);
}
function clearSession(res, role) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure; SameSite=None' : '; SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookie(role)}=; Path=/; HttpOnly${secure}; Max-Age=0`);
}
async function getUser(req, role) {
  const database = await connect();
  const token = cookie(req, sessionCookie(role)) || cookie(req, 'mansah_session');
  if (!token) return null;
  const session = await database.collection('sessions').findOne({ token: digest(token), expires: { $gt: Date.now() } });
  if (!session) return null;
  return database.collection('users').findOne({ id: session.user_id });
}
async function audit(actor, action, target) {
  await db.collection('audit').insertOne({ id: crypto.randomUUID(), actor, action, target, created: Date.now() });
}

const starterCatalog = [
  { name: 'رياضيات', description: 'جبر، هندسة، تفاضل وتكامل', icon: '∑', levels: ['مدرسي', 'توجيهي', 'جامعي'], subjects: ['رياضيات', 'فيزياء رياضية'] },
  { name: 'علوم', description: 'فيزياء، كيمياء، أحياء', icon: '⚗', levels: ['مدرسي', 'توجيهي'], subjects: ['فيزياء', 'كيمياء', 'أحياء'] },
  { name: 'لغات', description: 'عربي، إنجليزي، محادثة وكتابة', icon: 'Aa', levels: ['مبتدئ', 'متوسط', 'متقدم'], subjects: ['لغة عربية', 'لغة إنجليزية'] },
];
async function seedCatalog() {
  if (await db.collection('catalog').countDocuments({ kind: 'category' })) return;
  await db.collection('catalog').insertMany(starterCatalog.map((item, index) => ({ id: crypto.randomUUID(), kind: 'category', position: index, created: Date.now(), ...item })));
}
async function categories() {
  return db.collection('catalog').find({ kind: 'category' }, { projection: { _id: 0 } }).sort({ position: 1, id: 1 }).toArray();
}
async function handleCatalog(user, write, body) {
  if (write) {
    if (user.role !== 'admin') fail(403, 'تعديل التصنيفات متاح للإدارة فقط.');
    const rows = await categories();
    if (body.action === 'reorder') {
      if (!Array.isArray(body.ids) || body.ids.length !== rows.length || new Set(body.ids).size !== body.ids.length) fail(409, 'تغيرت التصنيفات. حدث الصفحة وأعد المحاولة.');
      await Promise.all(body.ids.map((id, index) => db.collection('catalog').updateOne({ id, kind: 'category' }, { $set: { position: index } })));
      await audit(user.id, 'catalog:reorder', 'categories');
    } else if (body.action === 'delete') {
      await db.collection('catalog').deleteOne({ id: body.id, kind: 'category' });
      await audit(user.id, 'catalog:delete', body.id);
    } else if (body.action === 'save') {
      const list = value => {
        if (!Array.isArray(value) || value.length > 100) fail(400, 'تحقق من المستويات والمواد.');
        return [...new Set(value.map(item => field(item, 100)))];
      };
      const item = { name: field(body.name, 100), description: field(body.description || '', 300, 0), icon: field(body.icon || '', 20, 0), levels: list(body.levels), subjects: list(body.subjects) };
      if (body.id) await db.collection('catalog').updateOne({ id: body.id, kind: 'category' }, { $set: item });
      else await db.collection('catalog').insertOne({ ...item, id: crypto.randomUUID(), kind: 'category', position: rows.length, created: Date.now() });
    } else fail(400, 'عملية غير صحيحة.');
  }
  return { categories: await categories() };
}

async function bookingRows(filter = {}, limit = 500) {
  const bookings = await db.collection('bookings').find(filter, { projection: { _id: 0 } }).sort({ created: -1 }).limit(limit).toArray();
  return enrichBookings(bookings);
}
async function enrichBookings(bookings) {
  const slotIds = [...new Set(bookings.map(b => b.slot_id))];
  const slots = await db.collection('slots').find({ id: { $in: slotIds } }, { projection: { _id: 0 } }).toArray();
  const slotMap = new Map(slots.map(s => [s.id, s]));
  const userIds = [...new Set(slots.flatMap(s => [s.teacher_id]).concat(bookings.map(b => b.student_id)))];
  const users = await db.collection('users').find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, name: 1, bio: 1, subject: 1 } }).toArray();
  const userMap = new Map(users.map(u => [u.id, u]));
  return bookings.map(b => {
    const s = slotMap.get(b.slot_id) || {};
    const teacher = userMap.get(s.teacher_id) || {};
    const student = userMap.get(b.student_id) || {};
    return { ...s, ...b, teacher_id: s.teacher_id, teacher_name: teacher.name || '', student_name: student.name || '', bio: teacher.bio || '', teacher_subjects: teacher.subject || '' };
  });
}
async function walletBalance(userId) {
  const rows = await db.collection('wallet_transactions').aggregate([{ $match: { user_id: userId } }, { $group: { _id: null, balance: { $sum: '$amount' } } }]).toArray();
  return Number(rows[0]?.balance || 0);
}

app.all('/api/auth/:action', async (req, res, next) => {
  try {
    await connect();
    const action = req.params.action;
    const body = req.body || {};
    const requestedRole = req.query.portal || body.role;
    if (action === 'me') return res.json({ user: publicUser(await getUser(req, requestedRole)) });
    if (action === 'logout') {
      const token = cookie(req, sessionCookie(requestedRole));
      if (token) await db.collection('sessions').deleteOne({ token: digest(token) });
      clearSession(res, requestedRole);
      return res.json({ user: null });
    }
    if (!['login', 'register', 'setup'].includes(action)) fail(404, 'الطلب غير موجود.');
    const email = field(body.email, 254).toLowerCase();
    const password = field(body.password, 128, 12);
    const role = body.role;
    if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
    let user;
    if (action === 'login') {
      user = await db.collection('users').findOne({ email });
      const hash = passwordHash(password, user?.password?.split(':')[0] || 'missing-account-salt');
      if (!user || user.role !== role || !equal(hash, user.password)) fail(401, 'بيانات الدخول غير صحيحة لهذا القسم.');
      if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
    } else {
      if (action === 'setup') {
        if (String(body.token || '') !== OWNER_SETUP_TOKEN || role !== 'admin') fail(403, 'رابط تهيئة الإدارة غير صالح.');
        if (await db.collection('users').findOne({ role: 'admin' })) fail(409, 'تم إنشاء حساب الإدارة مسبقاً. سجل الدخول.');
      } else if (role === 'admin') fail(403, 'إنشاء حساب إدارة غير متاح للعامة.');
      user = { id: role === 'admin' ? 'platform-owner' : crypto.randomUUID(), email, name: field(body.name, 100), role, status: role === 'teachers' ? 'pending' : 'active', password: passwordHash(password), subject: '', bio: '', created: Date.now(), must_change_password: 0 };
      try { await db.collection('users').insertOne(user); } catch { fail(409, 'البريد مستخدم مسبقاً أو حساب الإدارة موجود.'); }
    }
    const token = random();
    const expires = Date.now() + 604800000;
    await db.collection('sessions').deleteMany({ expires: { $lt: Date.now() } });
    await db.collection('sessions').insertOne({ token: digest(token), user_id: user.id, expires });
    setSession(res, role, token, expires);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.all('/api/:portal/*path', async (req, res, next) => {
  try {
    await connect();
    const portal = req.params.portal;
    const path = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const write = req.method !== 'GET';
    const body = req.body || {};
    const user = await getUser(req, portal);
    if (!user) fail(401, 'يلزم تسجيل الدخول.');
    if (portal !== user.role) fail(403, 'هذا القسم غير متاح لحسابك.');
    if (user.status === 'suspended') fail(403, 'الحساب موقوف.');

    if (path === 'profile') {
      if (write) await db.collection('users').updateOne({ id: user.id }, { $set: { name: field(body.name, 100), subject: field(body.subject || '', 100, 0), bio: field(body.bio || '', 2000, 0), academic_level: field(body.academic_level || '', 100, 0), phone: field(body.phone || '', 40, 0) } });
      return res.json({ user: publicUser(await db.collection('users').findOne({ id: user.id })) });
    }
    if (path === 'password' && write) {
      const old = field(body.current, 128, 12), nextPass = field(body.password, 128, 12);
      if (!equal(passwordHash(old, user.password.split(':')[0]), user.password)) fail(400, 'كلمة المرور الحالية غير صحيحة.');
      await db.collection('users').updateOne({ id: user.id }, { $set: { password: passwordHash(nextPass), must_change_password: 0 }, $unset: { temporary_password_expires: '' } });
      await db.collection('sessions').deleteMany({ user_id: user.id });
      return res.json({ ok: true });
    }
    if (user.status !== 'active') fail(403, 'هذا الحساب بانتظار موافقة الإدارة.');
    if (path === 'catalog') return res.json(await handleCatalog(user, write, body));
    if (path === 'users' && user.role === 'admin' && !write) return res.json({ users: (await db.collection('users').find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(1000).toArray()).map(publicUser) });
    if (/^users\/[^/]+$/.test(path) && user.role === 'admin' && write) {
      const id = path.split('/')[1];
      if (!['active', 'suspended'].includes(body.status)) fail(400, 'حالة غير صالحة.');
      await db.collection('users').updateOne({ id, role: { $ne: 'admin' } }, { $set: { status: body.status } });
      await db.collection('sessions').deleteMany({ user_id: id });
      await audit(user.id, `user:${body.status}`, id);
      return res.json({ ok: true });
    }
    if (/^users\/[^/]+\/reset-password$/.test(path) && user.role === 'admin' && write) {
      if (!equal(passwordHash(field(body.adminPassword, 128, 12), user.password.split(':')[0]), user.password)) fail(403, 'كلمة مرور الأدمن غير صحيحة.');
      const id = path.split('/')[1];
      const temporaryPassword = random().slice(0, 24);
      const expires = Date.now() + 86400000;
      await db.collection('users').updateOne({ id, role: { $in: ['teachers', 'students'] } }, { $set: { password: passwordHash(temporaryPassword), must_change_password: 1, temporary_password_expires: expires } });
      await db.collection('sessions').deleteMany({ user_id: id });
      await audit(user.id, 'user:password-reset', id);
      return res.json({ temporaryPassword, expires });
    }
    if (path === 'audit' && user.role === 'admin' && !write) return res.json({ events: await db.collection('audit').find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(100).toArray() });
    if (path === 'wallet' && user.role === 'students') {
      if (write) {
        const amount = Math.round(Number(body.amount) * 100);
        if (!Number.isInteger(amount) || amount < 100 || amount > 1000000) fail(400, 'أدخل مبلغاً صالحاً.');
        await db.collection('wallet_transactions').insertOne({ id: crypto.randomUUID(), user_id: user.id, type: 'sandbox_topup', amount, reference: `sandbox-${random().slice(0, 10)}`, created: Date.now() });
      }
      return res.json({ balance: await walletBalance(user.id), transactions: await db.collection('wallet_transactions').find({ user_id: user.id }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(100).toArray() });
    }
    if (['overview', 'home', 'booked', 'available', 'history', 'reminders'].includes(path) && !write) {
      const bookings = await bookingRows(user.role === 'admin' ? {} : user.role === 'teachers' ? {} : { student_id: user.id });
      const owned = user.role === 'teachers' ? bookings.filter(b => b.teacher_id === user.id) : bookings;
      const slots = user.role === 'teachers' ? await db.collection('slots').find({ teacher_id: user.id }, { projection: { _id: 0 } }).sort({ start: -1 }).limit(500).toArray() : undefined;
      return res.json({ bookings: owned, ...(slots ? { slots } : {}) });
    }
    if (path === 'slots') {
      if (!write) {
        if (user.role === 'teachers') return res.json({ slots: await db.collection('slots').find({ teacher_id: user.id }, { projection: { _id: 0 } }).sort({ start: -1 }).limit(500).toArray() });
        const slots = await db.collection('slots').find({ status: 'open', available_until: { $gt: Date.now() } }, { projection: { _id: 0 } }).sort({ start: 1 }).limit(500).toArray();
        const teachers = await db.collection('users').find({ id: { $in: [...new Set(slots.map(s => s.teacher_id))] }, status: 'active' }, { projection: { _id: 0 } }).toArray();
        const teacherMap = new Map(teachers.map(t => [t.id, t]));
        return res.json({ slots: slots.filter(s => teacherMap.has(s.teacher_id)).map(s => ({ ...s, teacher_name: teacherMap.get(s.teacher_id).name, bio: teacherMap.get(s.teacher_id).bio || '', teacher_subjects: teacherMap.get(s.teacher_id).subject || '' })) });
      }
      if (user.role !== 'teachers') fail(403, 'إضافة المواعيد متاحة للأساتذة فقط.');
      const start = Number(body.start), minutes = Number(body.minutes), price = Number(body.price);
      const until = Number(body.available_until || body.availableUntil || start + minutes * 60000);
      if (!Number.isSafeInteger(start) || ![30, 45, 60, 90, 120].includes(minutes) || !Number.isInteger(price)) fail(400, 'تحقق من الموعد والمدة والسعر.');
      await db.collection('slots').insertOne({ id: crypto.randomUUID(), teacher_id: user.id, start, minutes, price, subject: field(body.subject, 100), available_until: until, status: 'open', created: Date.now() });
      return res.json({ ok: true });
    }
    if (path.startsWith('slots/') && write) {
      const id = path.split('/')[1];
      if (user.role === 'teachers') {
        await db.collection('slots').updateOne({ id, teacher_id: user.id, status: 'open' }, { $set: { status: 'cancelled' } });
        return res.json({ ok: true });
      }
      if (user.role !== 'students') fail(403, 'الحجز متاح للطلاب فقط.');
      const slot = await db.collection('slots').findOne({ id, status: 'open', available_until: { $gt: Date.now() } });
      if (!slot) fail(409, 'الموعد لم يعد متاحاً.');
      const bookingId = crypto.randomUUID();
      await db.collection('bookings').insertOne({ id: bookingId, slot_id: id, student_id: user.id, status: 'confirmed', room: random(), paid: 1, payment_ref: `sandbox-${random().slice(0, 10)}`, notes: '', resource: '', created: Date.now() });
      await db.collection('slots').updateOne({ id }, { $set: { status: 'booked' } });
      return res.json({ ok: true, id: bookingId });
    }
    const [category, id, action] = path.split('/');
    if (category === 'bookings' && id) {
      const row = (await enrichBookings([await db.collection('bookings').findOne({ id }, { projection: { _id: 0 } })]))[0];
      if (!row || (user.role !== 'admin' && row.teacher_id !== user.id && row.student_id !== user.id)) fail(404, 'الحصة غير موجودة.');
      if (action === 'room' && !write) return res.json({ room: row.room, role: user.role === 'teachers' ? 'teacher' : 'student' });
      if (action === 'messages') {
        if (write) await db.collection('messages').insertOne({ id: crypto.randomUUID(), booking_id: id, author_id: user.id, body: field(body.body, 2000), created: Date.now() });
        const messages = await db.collection('messages').find({ booking_id: id }, { projection: { _id: 0 } }).sort({ created: 1 }).limit(500).toArray();
        const users = await db.collection('users').find({ id: { $in: [...new Set(messages.map(m => m.author_id))] } }).toArray();
        const names = new Map(users.map(u => [u.id, u.name]));
        return res.json({ messages: messages.map(m => ({ ...m, name: names.get(m.author_id) || '' })) });
      }
      if (action === 'cancel' && write) {
        await db.collection('bookings').updateOne({ id }, { $set: { status: 'cancelled', room: random() } });
        await db.collection('slots').updateOne({ id: row.slot_id }, { $set: { status: 'open' } });
        await audit(user.id, 'booking:cancel', id);
        return res.json({ ok: true });
      }
      if (action === 'complete' && write && user.role === 'teachers') {
        await db.collection('bookings').updateOne({ id }, { $set: { status: 'completed', room: random() } });
        return res.json({ ok: true });
      }
      if (action === 'notes' && write && user.role === 'teachers') {
        await db.collection('bookings').updateOne({ id }, { $set: { notes: field(body.notes || '', 5000, 0), resource: field(body.resource || '', 1000, 0) } });
        return res.json({ ok: true });
      }
      if (action === 'payment' && write && user.role === 'admin') {
        await db.collection('bookings').updateOne({ id }, { $set: { paid: body.paid ? 1 : 0, payment_ref: field(body.reference || '', 200, body.paid ? 1 : 0) } });
        await audit(user.id, body.paid ? 'payment:received' : 'payment:reversed', id);
        return res.json({ ok: true });
      }
    }
    fail(404, 'الطلب غير موجود أو غير متاح لحسابك.');
  } catch (error) { next(error); }
});

app.use(express.static(path.join(root, 'dist/client')));
app.get('*path', (_req, res) => res.sendFile(path.join(root, 'dist/client/index.html')));
app.use((error, _req, res, _next) => {
  if (!error.status) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'تعذر تنفيذ الطلب الآن. حاول مجدداً.' });
});

app.listen(PORT, () => {
  console.log(`Mansah backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Backend language: JavaScript (Node.js + Express). Database: MongoDB.`);
});
