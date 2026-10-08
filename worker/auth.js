import { one, run, statement, field, fail, auditEntry } from './db.js';
import { parseCustomPackages } from '../shared/custom-packages.js';
import { parseVerification, registrationProfile } from '../shared/verification.js';
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
export const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, subject: u.subject, bio: u.bio, academic_level: u.academic_level || '', phone: u.phone || '', avatar_url: u.role === 'teachers' ? `/api/media/avatar/${u.id}` : '', custom_packages: parseCustomPackages(u.custom_packages), verification: parseVerification(u.verification), auth_provider: u.auth_provider || 'password', email_verified: Boolean(u.email_verified), mustChangePassword: Boolean(u.must_change_password && !u.development_access) });
const sessionCookie = role => role && ['admin', 'teachers', 'students'].includes(role) ? `mansah_session_${role}` : 'mansah_session';
function developmentEnabled(env) {
  return typeof env.DEVELOPMENT_LOGIN_HASH === 'string' && /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(env.DEVELOPMENT_LOGIN_HASH) && Number(env.DEVELOPMENT_LOGIN_EXPIRES) > Date.now();
}
export async function getUser(request, env, role) {
  const cookies = request.headers.get('cookie') || '';
  const name = sessionCookie(role);
  const token = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`))?.[1] || cookies.match(/(?:^|;\s*)mansah_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const user = await one(env, 'SELECT u.*,s.development_key FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', await digest(token), Date.now());
  if (user?.development_key) {
    if (!developmentEnabled(env) || !['teachers', 'students'].includes(user.role) || !equal(user.development_key, await digest(env.DEVELOPMENT_LOGIN_HASH))) return null;
    user.development_access = true;
  }
  return user;
}
export async function auth(request, env, action, body) {
  const requestedRole = new URL(request.url).searchParams.get('portal') || body.role;
  if (action === 'me') { const user = await getUser(request, env, requestedRole); return { user: user ? publicUser(user) : null }; }
  if (action === 'logout') {
    const name = sessionCookie(requestedRole);
    const token = request.headers.get('cookie')?.match(new RegExp(`${name}=([a-f0-9]{64})`))?.[1];
    if (token) await run(env, 'DELETE FROM sessions WHERE token=?', await digest(token));
    return { cookie: `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, user: null };
  }
  if (!['login', 'register', 'setup', 'google'].includes(action)) fail(404, 'الطلب غير موجود.');
  let google = null;
  if (action === 'google') {
    if (!env.GOOGLE_CLIENT_ID) fail(503, 'تسجيل Google غير مفعّل على الخادم بعد.');
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(field(body.credential, 5000))}`);
    const profile = await response.json().catch(() => ({}));
    if (!response.ok || profile.aud !== env.GOOGLE_CLIENT_ID || profile.email_verified !== 'true' || !profile.email) fail(401, 'تعذر التحقق من حساب Google.');
    google = { email: String(profile.email).toLowerCase(), name: String(profile.name || ''), sub: String(profile.sub || '') };
  }
  const email = google?.email || field(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'البريد الإلكتروني غير صحيح.');
  const password = action === 'google' ? '' : field(body.password, 128, 12);
  const role = body.role;
  if (!['admin', 'teachers', 'students'].includes(role)) fail(400, 'القسم غير صحيح.');
  let user;
  let developmentAccess = false;
  if (action === 'login') {
    user = await one(env, 'SELECT * FROM users WHERE email=?', email);
    const hash = await passwordHash(password, user?.password.split(':')[0] || 'missing-account-salt');
    if (user && user.role === role && ['teachers', 'students'].includes(role) && !equal(hash, user.password) && developmentEnabled(env)) {
      developmentAccess = equal(await passwordHash(password, env.DEVELOPMENT_LOGIN_HASH.split(':')[0]), env.DEVELOPMENT_LOGIN_HASH);
    }
    if (!user || (!equal(hash, user.password) && !developmentAccess) || user.role !== role) fail(401, 'بيانات الدخول غير صحيحة لهذا القسم.');
    if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
    if (!developmentAccess && user.must_change_password && user.temporary_password_expires <= Date.now()) fail(401, 'انتهت صلاحية كلمة المرور المؤقتة. اطلب كلمة جديدة من الإدارة.');
  } else if (action === 'google') {
    user = await one(env, 'SELECT * FROM users WHERE email=?', email);
    if (user && user.role !== role) fail(409, 'هذا البريد مرتبط بقسم مختلف.');
    if (!user) {
      if (role === 'admin') fail(403, 'تسجيل Google غير متاح للإدارة.');
      const verification = registrationProfile(body, role);
      user = { id: crypto.randomUUID(), email, name: [verification.first_name, verification.father_name, verification.family_name].join(' '), role, status: role === 'teachers' ? 'pending' : 'active', password: await passwordHash(random()), subject: '', bio: role === 'teachers' ? verification.professional_bio : '', phone: verification.phone, verification: JSON.stringify(verification), auth_provider: 'google', email_verified: 1 };
      try { await run(env, 'INSERT INTO users (id,email,name,role,status,password,subject,bio,phone,verification,auth_provider,email_verified,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', user.id, email, user.name, role, user.status, user.password, '', user.bio, user.phone, user.verification, 'google', 1, Date.now()); }
      catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'البريد مستخدم مسبقًا.'); throw e; }
    } else {
      await run(env, "UPDATE users SET auth_provider='google',email_verified=1 WHERE id=?", user.id);
      user = { ...user, auth_provider: 'google', email_verified: 1 };
    }
    if (user.status === 'suspended') fail(403, 'الحساب موقوف. راجع الإدارة.');
  } else {
    if (action === 'setup') {
      if (!env.OWNER_SETUP_TOKEN || !equal(String(body.token || ''), env.OWNER_SETUP_TOKEN) || role !== 'admin') fail(403, 'رابط تهيئة الإدارة غير صالح.');
      if (await one(env, "SELECT id FROM users WHERE role='admin'")) fail(409, 'تم إنشاء حساب الإدارة مسبقًا. سجّل الدخول.');
    } else if (role === 'admin') fail(403, 'إنشاء حساب إدارة غير متاح للعامة.');
    const verification = role === 'admin' ? {} : registrationProfile(body, role);
    user = { id: role === 'admin' ? 'platform-owner' : crypto.randomUUID(), email, name: role === 'admin' ? field(body.name, 100) : [verification.first_name, verification.father_name, verification.family_name].join(' '), role, status: role === 'teachers' ? 'pending' : 'active', password: await passwordHash(password), subject: '', bio: role === 'teachers' ? verification.professional_bio : '', phone: verification.phone || '', verification: JSON.stringify(verification), auth_provider: 'password', email_verified: 0 };
    try {
      await run(env, 'INSERT INTO users (id,email,name,role,status,password,subject,bio,phone,verification,auth_provider,email_verified,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', user.id, email, user.name, role, user.status, user.password, '', user.bio, user.phone, user.verification, user.auth_provider, user.email_verified, Date.now());
    } catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'البريد مستخدم مسبقًا أو حساب الإدارة موجود.'); throw e; }
  }
  const token = random();
  const expires = developmentAccess ? Math.min(Date.now() + 604800000, Number(env.DEVELOPMENT_LOGIN_EXPIRES)) : Date.now() + 604800000;
  const results = await env.DB.batch([
    statement(env, 'DELETE FROM sessions WHERE expires<?', Date.now()),
    statement(env, "INSERT INTO sessions (token,user_id,expires,development_key) SELECT ?,id,?,? FROM users WHERE id=? AND password=? AND status!='suspended'", await digest(token), expires, developmentAccess ? await digest(env.DEVELOPMENT_LOGIN_HASH) : null, user.id, user.password),
    statement(env, 'DELETE FROM limits WHERE expires<?', Date.now()),
    ...(developmentAccess ? [auditEntry(env, user.id, 'user:development-login', user.id)] : []),
  ]);
  if (!results[1].meta.changes) fail(401, 'تغيرت بيانات الحساب. سجّل الدخول مجددًا.');
  return { user: publicUser({ ...user, development_access: developmentAccess }), cookie: `${sessionCookie(role)}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}` };
}
