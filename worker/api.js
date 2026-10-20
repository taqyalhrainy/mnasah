import { all, one, run, statement, field, fail, auditEntry } from './db.js';
import { getUser, publicUser, passwordHash, equal, random } from './auth.js';
import { catalog } from './catalog.js';
import { handleChat, ensureChat } from '../shared/chat.js';
import { sqlChatStore } from './chat-store.js';
import { paymentRange, paymentSummary } from '../shared/payments.js';
import { workerChatAttachment } from './chat-attachments.js';
import { serializeCustomPackages } from '../shared/custom-packages.js';
import { parseVerification } from '../shared/verification.js';
import { workerVerificationFile } from './verification-files.js';
import { workerWalletTopup } from './wallet-topups.js';
import { paymentSettings, publicTopup } from '../shared/wallet-topups.js';

const bookingSelect = `SELECT b.id,b.slot_id,b.student_id,b.status,b.paid,b.payment_ref,b.notes,b.resource,b.created,b.teacher_present_until,b.student_present_until,b.teacher_peer_id,b.student_peer_id,s.teacher_id,s.start,s.minutes,s.price,s.subject,s.available_until,t.name AS teacher_name,p.name AS student_name FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN users t ON t.id=s.teacher_id JOIN users p ON p.id=b.student_id`;
const allowedDurations = [30, 45, 60, 90, 120];
const parseList = (value, fallback) => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) && parsed.length ? parsed : fallback; } catch { return fallback; } };
const normalizeSlot = slot => slot ? ({ ...slot, legacy_all_subjects: (!slot.subjects || slot.subjects === '[]') && slot.subject === 'كل المواد المختارة', subjects: parseList(slot.subjects, [slot.subject].filter(Boolean)), offerings: parseList(slot.offerings, [{ minutes: slot.minutes, price: slot.price }]) }) : slot;
function slotSubjects(body) {
  const values = Array.isArray(body.subjects) ? body.subjects : [body.subject];
  const subjects = [...new Set(values.map(value => field(value, 100)).filter(Boolean))];
  if (!subjects.length || subjects.length > 20) fail(400, 'اختر مادة واحدة على الأقل.');
  return subjects;
}
function slotOfferings(body) {
  const values = Array.isArray(body.offerings) && body.offerings.length ? body.offerings : [{ minutes: body.minutes, price: body.price }];
  const offerings = [...new Map(values.map(item => ({ minutes: Number(item?.minutes), price: Number(item?.price) })).map(item => [item.minutes, item])).values()].sort((left, right) => left.minutes - right.minutes);
  if (!offerings.length || offerings.length > allowedDurations.length || offerings.some(item => !allowedDurations.includes(item.minutes) || !Number.isInteger(item.price) || item.price < 0 || item.price > 100000)) fail(400, 'تحقق من مدد الحصة وأسعارها.');
  return offerings;
}
const commissionPercent = env => Math.max(0, Math.min(90, Number(env.PLATFORM_COMMISSION_PERCENT || 15)));
async function walletBalance(env, userId) {
  await ensureWalletAccount(env, userId);
  return Number((await one(env, 'SELECT balance FROM wallet_accounts WHERE user_id=?', userId))?.balance || 0);
}
async function ensureWalletAccount(env, userId) {
  await run(env, 'INSERT OR IGNORE INTO wallet_accounts (user_id,balance,updated) SELECT ?,COALESCE(SUM(amount),0),? FROM wallet_transactions WHERE user_id=?', userId, Date.now(), userId);
}
async function booking(env, id, user) {
  const row = await one(env, `${bookingSelect} WHERE b.id=?`, id);
  if (!row || (user.role !== 'admin' && row.teacher_id !== user.id && row.student_id !== user.id)) fail(404, 'الحصة غير موجودة.');
  return row;
}
export async function api(request, env, portal, path, body) {
  const user = await getUser(request, env, portal);
  if (!user) fail(401, 'يلزم تسجيل الدخول.');
  if (portal !== user.role) fail(403, 'هذا القسم غير متاح لحسابك.');
  if (user.status === 'suspended') fail(403, 'الحساب موقوف.');
  const write = request.method !== 'GET';
  if (!user.development_access && user.must_change_password && user.temporary_password_expires <= Date.now()) fail(401, 'انتهت صلاحية كلمة المرور المؤقتة. راجع الإدارة.');
  if (!user.development_access && user.must_change_password && path !== 'password') fail(403, 'يجب تغيير كلمة المرور المؤقتة أولاً.');
  const verificationFile = await workerVerificationFile(request, env, user, path);
  if (verificationFile) return verificationFile;
  const walletTopup = await workerWalletTopup(request, env, user, path);
  if (walletTopup) return walletTopup;
  if (path === 'verification/status' && !write && user.role === 'teachers') return { user: publicUser(user), files: await all(env, 'SELECT id,user_id,kind,name,size,content_type,created FROM verification_files WHERE user_id=?', user.id) };
  if (path === 'verification/submit' && write && user.role === 'teachers') {
    const files = await all(env, 'SELECT id,kind FROM verification_files WHERE user_id=?', user.id);
    if (!files.some(file => file.kind === 'avatar') || !files.some(file => file.kind === 'intro_video') || !files.some(file => file.kind === 'credential')) fail(400, 'أكمل الصورة وفيديو التحقق والمستند الداعم قبل إرسال الطلب.');
    const verification = { ...parseVerification(user.verification), verification_status: 'submitted', submitted_at: Date.now(), reviewed_at: 0, rejection_reason: '' };
    await run(env, 'UPDATE users SET verification=? WHERE id=?', JSON.stringify(verification), user.id);
    return { user: publicUser({ ...user, verification }) };
  }
  if (path === 'profile') {
    if (write) await run(env, 'UPDATE users SET name=?,subject=?,bio=?,academic_level=?,phone=?,custom_packages=? WHERE id=?', field(body.name, 100), field(body.subject || '', 4000, 0), field(body.bio || '', 2000, 0), field(body.academic_level || '', 100, 0), field(body.phone || '', 40, 0), body.custom_packages === undefined ? (user.custom_packages || '[]') : serializeCustomPackages(body.custom_packages), user.id);
    return { user: publicUser({ ...await one(env, 'SELECT * FROM users WHERE id=?', user.id), development_access: user.development_access }) };
  }
  if (path === 'password' && write) {
    const old = field(body.current, 128, 12), next = field(body.password, 128, 12);
    if (!equal(await passwordHash(old, user.password.split(':')[0]), user.password)) fail(400, 'كلمة المرور الحالية غير صحيحة.');
    if (old === next) fail(400, 'اختر كلمة مرور مختلفة عن الحالية.');
    const result = await env.DB.batch([statement(env, 'UPDATE users SET password=?,must_change_password=0,temporary_password_expires=NULL WHERE id=? AND password=?', await passwordHash(next), user.id, user.password), statement(env, 'DELETE FROM sessions WHERE user_id=?', user.id)]);
    if (!result[0].meta.changes) fail(409, 'تغيّرت بيانات الحساب. حاول تسجيل الدخول مجدداً.');
    return { ok: true };
  }
  if (user.status !== 'active') fail(403, 'هذا الحساب بانتظار موافقة الإدارة.');
  if (path.startsWith('chat/')) {
    const attachment = await workerChatAttachment(request, env, user, path);
    if (attachment) return attachment;
    return (await handleChat({ store: sqlChatStore(env), user, path, write, body, query: Object.fromEntries(new URL(request.url).searchParams) })).data;
  }
  if (path === 'reminders' && !write && user.role !== 'admin') {
    const ownerColumn = user.role === 'teachers' ? 's.teacher_id' : 'b.student_id';
    return { bookings: await all(env, `${bookingSelect} WHERE ${ownerColumn}=? AND b.status='confirmed' AND s.start>=? AND s.start<=? ORDER BY s.start LIMIT 100`, user.id, Date.now() - 300000, Date.now() + 86400000) };
  }
  if (path === 'rooms' && !write && user.role !== 'admin') {
    const ownerColumn = user.role === 'teachers' ? 's.teacher_id' : 'b.student_id';
    return { bookings: await all(env, `${bookingSelect} WHERE ${ownerColumn}=? ORDER BY s.start DESC LIMIT 500`, user.id) };
  }
  if (path === 'catalog') return catalog(env, user, write, body);
  if (path === 'payments' && !write && ['admin', 'teachers'].includes(user.role)) {
    const range = paymentRange(Object.fromEntries(new URL(request.url).searchParams));
    const rows = await all(env, `${bookingSelect} WHERE b.status='completed' AND s.start>=? AND s.start<?${user.role === 'teachers' ? ' AND s.teacher_id=?' : ''} ORDER BY s.start DESC`, range.from, range.until, ...(user.role === 'teachers' ? [user.id] : []));
    return paymentSummary(rows, range, commissionPercent(env));
  }
  if (user.role === 'teachers' && !write && ['home', 'booked', 'available', 'history'].includes(path)) {
    return { bookings: await all(env, `${bookingSelect} WHERE s.teacher_id=? ORDER BY s.start DESC LIMIT 500`, user.id), slots: await all(env, 'SELECT * FROM slots WHERE teacher_id=? ORDER BY start DESC LIMIT 500', user.id) };
  }
  if (path === 'overview' && !write) {
    const where = user.role === 'admin' ? '' : user.role === 'teachers' ? ' WHERE s.teacher_id=?' : ' WHERE b.student_id=?';
    return { bookings: await all(env, `${bookingSelect}${where} ORDER BY s.start DESC LIMIT 500`, ...(where ? [user.id] : [])) };
  }
  if (path === 'users' && user.role === 'admin' && !write) {
    const rows = await all(env, 'SELECT * FROM users ORDER BY created DESC LIMIT 1000');
    const files = await all(env, 'SELECT id,user_id,kind,name,size,content_type,created FROM verification_files ORDER BY created');
    return { users: rows.map(row => ({ ...publicUser(row), verification_files: files.filter(file => file.user_id === row.id) })) };
  }
  if (/^users\/[^/]+\/reset-password$/.test(path) && user.role === 'admin' && write) {
    const adminPassword = field(body.adminPassword, 128, 12);
    if (!equal(await passwordHash(adminPassword, user.password.split(':')[0]), user.password)) fail(403, 'كلمة مرور الأدمن غير صحيحة.');
    const id = path.split('/')[1];
    const target = await one(env, "SELECT id FROM users WHERE id=? AND role IN ('teachers','students')", id);
    if (!target) fail(404, 'الحساب غير موجود.');
    const temporaryPassword = random().slice(0, 24);
    const expires = Date.now() + 86400000;
    await env.DB.batch([
      statement(env, 'UPDATE users SET password=?,must_change_password=1,temporary_password_expires=? WHERE id=?', await passwordHash(temporaryPassword), expires, id),
      statement(env, 'DELETE FROM sessions WHERE user_id=?', id),
      auditEntry(env, user.id, 'user:password-reset', id),
    ]);
    return { temporaryPassword, expires };
  }
  if (/^users\/[^/]+$/.test(path) && user.role === 'admin' && write) {
    const id = path.split('/')[1];
    if (!['active', 'suspended'].includes(body.status)) fail(400, 'حالة غير صالحة.');
    const target = await one(env, "SELECT * FROM users WHERE id=? AND role!='admin'", id);
    if (!target) fail(404, 'الحساب غير موجود.');
    const verification = parseVerification(target.verification);
    if (body.status === 'active' && target.role === 'teachers' && verification.verification_status !== 'submitted') fail(409, 'طلب الأستاذ غير مكتمل أو لم يُرسل للمراجعة بعد.');
    const nextVerification = body.status === 'active' && target.role === 'teachers' ? JSON.stringify({ ...verification, verification_status: 'approved', reviewed_at: Date.now(), reviewed_by: user.id }) : target.verification;
    await env.DB.batch([statement(env, 'UPDATE users SET status=?,verification=? WHERE id=?', body.status, nextVerification, id), statement(env, 'DELETE FROM sessions WHERE user_id=?', id), auditEntry(env, user.id, `user:${body.status}`, id)]);
    return { ok: true };
  }
  if (path === 'audit' && user.role === 'admin' && !write) return { events: await all(env, 'SELECT a.*,u.name FROM audit a JOIN users u ON u.id=a.actor ORDER BY a.created DESC LIMIT 100') };
  if (path === 'wallet' && user.role === 'students' && !write) {
    const settings = paymentSettings((await one(env, "SELECT value FROM platform_settings WHERE key='payments'"))?.value);
    return { balance: await walletBalance(env, user.id), payment: { ...settings, ready: Boolean(settings.cliq_alias && settings.cliq_name) }, topups: (await all(env, 'SELECT * FROM wallet_topups WHERE user_id=? ORDER BY created DESC LIMIT 100', user.id)).map(publicTopup), transactions: await all(env, 'SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY created DESC LIMIT 100', user.id) };
  }
  if (path === 'wallet-topups' && user.role === 'admin' && !write) {
    const settings = paymentSettings((await one(env, "SELECT value FROM platform_settings WHERE key='payments'"))?.value);
    const rows = await all(env, 'SELECT w.*,u.name AS user_name,u.email AS user_email FROM wallet_topups w JOIN users u ON u.id=w.user_id ORDER BY w.created DESC LIMIT 500');
    return { settings, topups: rows.map(publicTopup) };
  }
  if (path === 'wallet-topups/settings' && user.role === 'admin' && write) {
    const settings = { cliq_alias: field(body.cliq_alias, 100), cliq_name: field(body.cliq_name, 100) };
    await env.DB.batch([statement(env, "INSERT INTO platform_settings (key,value) VALUES ('payments',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(settings)), auditEntry(env, user.id, 'wallet:settings', 'payments')]);
    return { settings };
  }
  if (/^wallet-topups\/[^/]+\/(approve|reject)$/.test(path) && user.role === 'admin' && write) {
    const [, id, action] = path.split('/');
    const topup = await one(env, 'SELECT * FROM wallet_topups WHERE id=?', id);
    if (!topup || topup.status !== 'pending') fail(409, 'تمت مراجعة طلب الشحن مسبقاً.');
    if (action === 'reject') {
      const result = await env.DB.batch([statement(env, "UPDATE wallet_topups SET status='rejected',reviewed_at=?,reviewed_by=?,rejection_reason=? WHERE id=? AND status='pending'", Date.now(), user.id, field(body.reason, 300), id), auditEntry(env, user.id, 'wallet:topup-reject', id)]);
      if (!result[0].meta.changes) fail(409, 'تمت مراجعة طلب الشحن مسبقاً.');
      return { ok: true };
    }
    await ensureWalletAccount(env, topup.user_id);
    const reference = `wallet-topup:${id}`;
    const result = await env.DB.batch([
      statement(env, "UPDATE wallet_topups SET status='approved',reviewed_at=?,reviewed_by=?,rejection_reason='' WHERE id=? AND status='pending'", Date.now(), user.id, id),
      statement(env, "UPDATE wallet_accounts SET balance=balance+?,updated=? WHERE user_id=? AND EXISTS (SELECT 1 FROM wallet_topups WHERE id=? AND status='approved') AND NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE reference=?)", topup.amount, Date.now(), topup.user_id, id, reference),
      statement(env, "INSERT INTO wallet_transactions (id,user_id,type,amount,reference,created) SELECT ?,?,'cliq_topup',?,?,? WHERE EXISTS (SELECT 1 FROM wallet_topups WHERE id=? AND status='approved') AND NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE reference=?)", crypto.randomUUID(), topup.user_id, topup.amount, reference, Date.now(), id, reference),
      auditEntry(env, user.id, 'wallet:topup-approve', id),
    ]);
    if (!result[0].meta.changes) fail(409, 'تمت مراجعة طلب الشحن مسبقاً.');
    return { ok: true };
  }
  if (path === 'earnings' && user.role === 'teachers' && !write) {
    const pct = commissionPercent(env);
    const completed = await all(env, `${bookingSelect} WHERE s.teacher_id=? AND b.status='completed' ORDER BY s.start DESC LIMIT 500`, user.id);
    const gross = completed.reduce((sum, b) => sum + b.price, 0);
    const fee = Math.round(gross * pct / 100);
    return { commissionPercent: pct, gross, fee, net: gross - fee, completed, payouts: await all(env, 'SELECT * FROM payouts WHERE teacher_id=? ORDER BY period_end DESC LIMIT 100', user.id) };
  }
  if (path === 'payouts' && user.role === 'admin' && !write) {
    const pct = commissionPercent(env);
    const rows = await all(env, `SELECT s.teacher_id,u.name AS teacher_name,COALESCE(SUM(s.price),0) AS gross,COUNT(*) AS lessons FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN users u ON u.id=s.teacher_id WHERE b.status='completed' GROUP BY s.teacher_id,u.name`);
    return { payouts: rows.map(r => ({ ...r, fee: Math.round(r.gross * pct / 100), net: r.gross - Math.round(r.gross * pct / 100), status: 'pending' })) };
  }
  if (/^payouts\/[^/]+\/paid$/.test(path) && user.role === 'admin' && write) {
    const teacherId = path.split('/')[1];
    const pct = commissionPercent(env);
    const row = await one(env, `SELECT COALESCE(SUM(s.price),0) AS gross FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.status='completed' AND s.teacher_id=?`, teacherId);
    const gross = Number(row?.gross || 0);
    await env.DB.batch([
      statement(env, 'INSERT INTO payouts (id,teacher_id,period_start,period_end,amount,status,paid_at,created) VALUES (?,?,?,?,?,?,?,?)', crypto.randomUUID(), teacherId, 0, Date.now(), gross - Math.round(gross * pct / 100), 'paid', Date.now(), Date.now()),
      auditEntry(env, user.id, 'payout:paid', teacherId),
    ]);
    return { ok: true };
  }
  if (path === 'slots') {
    if (!write) {
      if (user.role === 'teachers') return { slots: (await all(env, 'SELECT * FROM slots WHERE teacher_id=? ORDER BY start DESC LIMIT 500', user.id)).map(normalizeSlot) };
      return { slots: (await all(env, `SELECT s.*,u.name AS teacher_name,u.bio,u.subject AS teacher_subjects FROM slots s JOIN users u ON u.id=s.teacher_id WHERE s.status='open' AND u.status='active' AND COALESCE(NULLIF(s.available_until,0),s.start+s.minutes*60000)>? ORDER BY s.start LIMIT 500`, Date.now())).map(normalizeSlot) };
    }
    if (user.role !== 'teachers') fail(403, 'إضافة المواعيد متاحة للأساتذة فقط.');
    const start = Number(body.start), subjects = slotSubjects(body), offerings = slotOfferings(body);
    const defaultOffering = offerings[0], maxMinutes = Math.max(...offerings.map(item => item.minutes));
    const availableUntil = Number(body.available_until || body.availableUntil || 0);
    const hasAvailabilityWindow = Number.isSafeInteger(availableUntil) && availableUntil >= start + maxMinutes * 60000;
    const until = hasAvailabilityWindow ? availableUntil : start + maxMinutes * 60000;
    const now = Date.now();
    if (!Number.isSafeInteger(start) || start > now + 31536000000) fail(400, 'تحقق من الموعد والفترة المتاحة.');
    if (!hasAvailabilityWindow && start <= now) fail(400, 'اختر وقتاً مخصصاً بعد الوقت الحالي.');
    if (until <= now) fail(400, 'انتهت فترة التوفر. اختر وقت نهاية بعد الوقت الحالي.');
    const result = await run(env, `INSERT INTO slots (id,teacher_id,start,minutes,price,subject,subjects,offerings,available_until) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slots WHERE teacher_id=? AND status!='cancelled' AND start<? AND COALESCE(NULLIF(available_until,0),start+minutes*60000)>?)`, crypto.randomUUID(), user.id, start, defaultOffering.minutes, defaultOffering.price, subjects.length === 1 ? subjects[0] : 'كل المواد المختارة', JSON.stringify(subjects), JSON.stringify(offerings), until, user.id, until, start);
    if (!result.meta.changes) fail(409, 'الموعد يتعارض مع موعد آخر.');
    return { ok: true };
  }
  if (path.startsWith('slots/') && write) {
    const id = path.split('/')[1];
    if (user.role === 'teachers') {
      const r = await run(env, "UPDATE slots SET status='cancelled' WHERE id=? AND teacher_id=? AND status='open'", id, user.id);
      if (!r.meta.changes) fail(409, 'تعذر حذف الموعد لأنه غير متاح.');
      return { ok: true };
    }
    if (user.role !== 'students') fail(403, 'الحجز متاح للطلاب فقط.');
    const bookingId = crypto.randomUUID();
    const slot = normalizeSlot(await one(env, 'SELECT * FROM slots WHERE id=?', id));
    if (!slot) fail(404, 'الموعد غير موجود.');
    const legacyAllSubjects = slot.legacy_all_subjects;
    const requestedSubject = typeof body.subject === 'string' ? field(body.subject, 100) : '';
    const selectedSubject = requestedSubject && (slot.subjects.includes(requestedSubject) || legacyAllSubjects) ? requestedSubject : slot.subjects.length === 1 && !legacyAllSubjects ? slot.subjects[0] : '';
    const selectedOffering = slot.offerings.find(item => item.minutes === Number(body.minutes)) || (slot.offerings.length === 1 ? slot.offerings[0] : null);
    if (!selectedSubject) fail(400, 'اختر المادة التي تريد حجزها.');
    if (!selectedOffering) fail(400, 'اختر مدة الحصة التي تناسبك.');
    const method = body.method === 'wallet' || !user.development_access ? 'wallet' : 'sandbox';
    if (method === 'wallet') { await ensureWalletAccount(env, user.id); if (await walletBalance(env, user.id) < selectedOffering.price) fail(402, 'رصيد المحفظة غير كافٍ.'); }
    const walletCondition = method === 'wallet' ? ' AND EXISTS (SELECT 1 FROM wallet_accounts w WHERE w.user_id=? AND w.balance>=?)' : '';
    const bookingParams = [bookingId, user.id, random(), Date.now(), id, Date.now(), user.id, selectedOffering.minutes, ...(method === 'wallet' ? [user.id, selectedOffering.price] : [])];
    const statements = [
      statement(env, `INSERT INTO bookings (id,slot_id,student_id,status,room,created) SELECT ?,s.id,?,'confirmed',?,? FROM slots s JOIN users t ON t.id=s.teacher_id WHERE s.id=? AND s.status='open' AND COALESCE(NULLIF(s.available_until,0),s.start+s.minutes*60000)>? AND t.status='active' AND NOT EXISTS (SELECT 1 FROM bookings b JOIN slots x ON x.id=b.slot_id WHERE b.student_id=? AND b.status='confirmed' AND x.start<s.start+?*60000 AND x.start+x.minutes*60000>s.start)${walletCondition}`, ...bookingParams),
      statement(env, "UPDATE slots SET status='booked',subject=?,minutes=?,price=? WHERE id=? AND EXISTS (SELECT 1 FROM bookings WHERE id=?)", selectedSubject, selectedOffering.minutes, selectedOffering.price, id, bookingId),
      statement(env, 'UPDATE bookings SET paid=1,payment_ref=? WHERE id=?', method === 'wallet' ? 'wallet' : `sandbox-${random().slice(0, 10)}`, bookingId),
    ];
    if (method === 'wallet') statements.push(
      statement(env, 'UPDATE wallet_accounts SET balance=balance-?,updated=? WHERE user_id=? AND balance>=? AND EXISTS (SELECT 1 FROM bookings WHERE id=?)', selectedOffering.price, Date.now(), user.id, selectedOffering.price, bookingId),
      statement(env, "INSERT INTO wallet_transactions (id,user_id,type,amount,reference,created) SELECT ?,?,'lesson_payment',?,?,? WHERE EXISTS (SELECT 1 FROM bookings WHERE id=?)", crypto.randomUUID(), user.id, -selectedOffering.price, `lesson-payment:${bookingId}`, Date.now(), bookingId),
    );
    const results = await env.DB.batch(statements);
    if (!results[0].meta.changes) fail(409, 'الموعد لم يعد متاحاً أو يتعارض مع حجز آخر.');
    const teacher = await one(env, 'SELECT teacher_id FROM slots WHERE id=?', id);
    await ensureChat(sqlChatStore(env), teacher.teacher_id, user.id);
    return { ok: true, id: bookingId };
  }
  const [category, id, action] = path.split('/');
  if (category === 'bookings' && id) {
    const row = await booking(env, id, user);
    if (action === 'room' && !write) {
      if (user.role === 'admin' || row.status !== 'confirmed') fail(403, 'الدخول متاح فقط لطرفي الحصة المؤكدة.');
      const now = Date.now();
      if (now < row.start - 900000) fail(403, 'يمكن دخول الحصة قبل موعدها بخمس عشرة دقيقة.');
      const otherId = user.role === 'teachers' ? row.student_id : row.teacher_id;
      if (!(await one(env, "SELECT id FROM users WHERE id=? AND status='active'", otherId))) fail(403, 'حساب الطرف الآخر غير نشط.');
      return { room: (await one(env, 'SELECT room FROM bookings WHERE id=?', id)).room, role: user.role === 'teachers' ? 'teacher' : 'student' };
    }
    if (action === 'presence') {
      if (user.role === 'admin' || row.status !== 'confirmed') fail(403, 'الحضور المباشر متاح فقط لطرفي الحصة المؤكدة.');
      if (write) {
        const column = user.role === 'teachers' ? 'teacher_present_until' : 'student_present_until';
        const peerColumn = user.role === 'teachers' ? 'teacher_peer_id' : 'student_peer_id';
        const until = body.active === false ? 0 : Date.now() + 45000;
        const peerId = body.active === false ? '' : field(body.peerId || '', 160, 0);
        await run(env, `UPDATE bookings SET ${column}=?,${peerColumn}=? WHERE id=?`, until, peerId, id);
        row[column] = until;
        row[peerColumn] = peerId;
      }
      const teacherLive = Number(row.teacher_present_until || 0) > Date.now();
      const studentLive = Number(row.student_present_until || 0) > Date.now();
      return {
        teacherLive,
        studentLive,
        teacher_present_until: Number(row.teacher_present_until || 0),
        student_present_until: Number(row.student_present_until || 0),
        teacherPeerId: teacherLive ? row.teacher_peer_id || null : null,
        studentPeerId: studentLive ? row.student_peer_id || null : null,
      };
    }
    if (action === 'messages') {
      if (write) {
        if (row.status === 'cancelled') fail(409, 'الحصة ملغاة.');
        await run(env, 'INSERT INTO messages VALUES (?,?,?,?,?)', crypto.randomUUID(), id, user.id, field(body.body, 2000), Date.now());
      }
      return { messages: await all(env, 'SELECT m.id,m.body,m.created,u.name FROM messages m JOIN users u ON u.id=m.author_id WHERE booking_id=? ORDER BY m.created LIMIT 500', id) };
    }
    if (action === 'cancel' && write) {
      if (row.status !== 'confirmed') fail(409, 'الحصة لم تعد قابلة للإلغاء.');
      const cancellationDeadline = Number(row.available_until) || row.start + row.minutes * 60000;
      if (user.role !== 'admin' && cancellationDeadline <= Date.now()) fail(409, 'انتهى وقت الإلغاء لهذه الحصة.');
      if (row.payment_ref === 'wallet') await ensureWalletAccount(env, row.student_id);
      const refundReference = `lesson-refund:${id}`;
      const results = await env.DB.batch([
        statement(env, "UPDATE bookings SET status='cancelled',room=? WHERE id=? AND status='confirmed'", random(), id),
        statement(env, "UPDATE slots SET status='open' WHERE id=? AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='cancelled') AND NOT EXISTS(SELECT 1 FROM bookings WHERE slot_id=? AND status='confirmed')", row.slot_id, id, row.slot_id),
        ...(row.payment_ref === 'wallet' ? [
          statement(env, "UPDATE wallet_accounts SET balance=balance+?,updated=? WHERE user_id=? AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='cancelled') AND NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE reference=?)", row.price, Date.now(), row.student_id, id, refundReference),
          statement(env, "INSERT INTO wallet_transactions (id,user_id,type,amount,reference,created) SELECT ?,?,'lesson_refund',?,?,? WHERE EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='cancelled') AND NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE reference=?)", crypto.randomUUID(), row.student_id, row.price, refundReference, Date.now(), id, refundReference),
        ] : []),
        auditEntry(env, user.id, 'booking:cancel', id),
      ]);
      if (!results[0].meta.changes) fail(409, 'الحصة لم تعد قابلة للإلغاء.');
      return { ok: true };
    }
    if (action === 'complete' && write && user.role === 'teachers') {
      if (row.start + row.minutes * 60000 > Date.now()) fail(409, 'لا يمكن إكمال الحصة قبل انتهاء موعدها.');
      const r = await run(env, "UPDATE bookings SET status='completed',room=? WHERE id=? AND status='confirmed'", random(), id);
      if (!r.meta.changes) fail(409, 'الحصة ليست مؤكدة.');
      return { ok: true };
    }
    if (action === 'notes' && write && user.role === 'teachers') {
      const resource = field(body.resource, 1000, 0);
      if (resource) { let url; try { url = new URL(resource); } catch { fail(400, 'رابط المادة غير صالح.'); } if (url.protocol !== 'https:') fail(400, 'الرابط يجب أن يستخدم HTTPS.'); }
      if (row.status === 'cancelled') fail(409, 'الحصة ملغاة.');
      await run(env, 'UPDATE bookings SET notes=?,resource=? WHERE id=?', field(body.notes, 5000, 0), resource, id);
      return { ok: true };
    }
    if (action === 'payment' && write && user.role === 'admin') {
      if (row.payment_ref === 'wallet') fail(409, 'دفعات المحفظة تُسجّل تلقائياً ولا يمكن تعديلها يدوياً.');
      if (![0, 1].includes(body.paid)) fail(400, 'حالة الدفع غير صالحة.');
      await env.DB.batch([statement(env, 'UPDATE bookings SET paid=?,payment_ref=? WHERE id=?', body.paid, field(body.reference, 200, body.paid ? 1 : 0), id), auditEntry(env, user.id, body.paid ? 'payment:received' : 'payment:reversed', id)]);
      return { ok: true };
    }
    if (action === 'rating' && write && user.role === 'students') {
      if (row.student_id !== user.id || row.status !== 'completed') fail(409, 'التقييم متاح بعد إكمال الحصة.');
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'اختر تقييماً بين 1 و5.');
      await run(env, 'INSERT OR REPLACE INTO ratings (id,booking_id,student_id,teacher_id,rating,review,created) VALUES (COALESCE((SELECT id FROM ratings WHERE booking_id=? AND student_id=?),?),?,?,?,?,?)', id, user.id, crypto.randomUUID(), id, user.id, row.teacher_id, rating, field(body.review, 1000, 0), Date.now());
      return { ok: true };
    }  }
  fail(404, 'الطلب غير موجود أو غير متاح لحسابك.');
}

