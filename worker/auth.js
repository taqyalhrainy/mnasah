import { one, run, statement, field, fail } from './db.js';
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export async function passwordHash(value, salt = random()) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `${salt}:${hex(hash)}`;
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, subject: u.subject, bio: u.bio, mustChangePassword: Boolean(u.must_change_password) });
export async function getUser(request, env) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)mansah_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  return one(env, 'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', await digest(token), Date.now());
}
export async function limit(env, key, max, windowMs) {
  const now = Date.now();
  const row = await statement(env, `INSERT INTO limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count`, key, now + windowMs, now, now).first();
  if (row.count > max) fail(429, 'محاولات كثيرة. حاول مجددًا بعد قليل.');
}
export async function auth(request, env, action, body) {
  if (action === 'me') return { user: (await getUser(request, env)) ? publicUser(await getUser(request, env)) : null };
  if (action === 'logout') {
    const token = request.headers.get('cookie')?.match(/mansah_session=([a-f0-9]{64})/)?.[1];
    if (token) await run(env, 'DELETE FROM sessions WHERE token=?', await digest(token));
    return { cookie: 'mansah_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0', user: null };
  }
  if (!['login', 'register', 'setup'].includes(action)) fail(404, 'الطلب غير موجود.');
  const email = field(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'البريد الإلكتروني غير صحيح.');
  await limit(env, `auth:${await digest(request.headers.get('cf-connecting-ip') || 'local')}`, 40, 900000);
  await limit(env, `email:${await digest(email)}`, 15, 900000);
  const password = field(body.password, 128, 12);
  const role = body.role;
  if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
  let user;
  if (action === 'login') {
    user = await one(env, 'SELECT * FROM users WHERE email=?', email);
    const hash = await passwordHash(password, user?.password.split(':')[0] || 'missing-account-salt');
    if (!user || !equal(hash, user.password) || user.role !== role) fail(401, 'بيانات الدخول غير صحيحة لهذا القسم.');
    if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
    if (user.must_change_password && user.temporary_password_expires <= Date.now()) fail(401, 'انتهت صلاحية كلمة المرور المؤقتة. اطلب كلمة جديدة من الإدارة.');
  } else {
    if (action === 'setup') {
      if (!env.OWNER_SETUP_TOKEN || !equal(String(body.token || ''), env.OWNER_SETUP_TOKEN) || role !== 'admin') fail(403, 'رابط تهيئة الإدارة غير صالح.');
      if (await one(env, "SELECT id FROM users WHERE role='admin'")) fail(409, 'تم إنشاء حساب الإدارة مسبقًا. سجّل الدخول.');
    } else if (role === 'admin') fail(403, 'إنشاء حساب إدارة غير متاح للعامة.');
    user = { id: role === 'admin' ? 'platform-owner' : crypto.randomUUID(), email, name: field(body.name, 100), role, status: role === 'teachers' ? 'pending' : 'active', password: await passwordHash(password), subject: '', bio: '' };
    try {
      await run(env, 'INSERT INTO users (id,email,name,role,status,password,created) VALUES (?,?,?,?,?,?,?)', user.id, email, user.name, role, user.status, user.password, Date.now());
    } catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'البريد مستخدم مسبقًا أو حساب الإدارة موجود.'); throw e; }
  }
  const token = random();
  const results = await env.DB.batch([
    statement(env, 'DELETE FROM sessions WHERE expires<?', Date.now()),
    statement(env, "INSERT INTO sessions (token,user_id,expires) SELECT ?,id,? FROM users WHERE id=? AND password=? AND status!='suspended'", await digest(token), Date.now() + 604800000, user.id, user.password),
    statement(env, 'DELETE FROM limits WHERE expires<?', Date.now()),
  ]);
  if (!results[1].meta.changes) fail(401, 'تغيرت بيانات الحساب. سجّل الدخول مجددًا.');
  return { user: publicUser(user), cookie: `mansah_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800` };
}
