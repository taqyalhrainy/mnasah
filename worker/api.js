import { all, one, run, statement, field, fail, auditEntry } from './db.js';
import { getUser, publicUser, passwordHash, equal, random } from './auth.js';

const bookingSelect = `SELECT b.id,b.slot_id,b.student_id,b.status,b.paid,b.payment_ref,b.notes,b.resource,b.created,s.teacher_id,s.start,s.minutes,s.price,s.subject,t.name AS teacher_name,p.name AS student_name FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN users t ON t.id=s.teacher_id JOIN users p ON p.id=b.student_id`;
async function booking(env, id, user) {
  const row = await one(env, `${bookingSelect} WHERE b.id=?`, id);
  if (!row || (user.role !== 'admin' && row.teacher_id !== user.id && row.student_id !== user.id)) fail(404, 'الحصة غير موجودة.');
  return row;
}
export async function api(request, env, portal, path, body) {
  const user = await getUser(request, env);
  if (!user) fail(401, 'سجّل الدخول للمتابعة.');
  if (portal !== user.role) fail(403, 'هذا القسم غير متاح لحسابك.');
  if (user.status === 'suspended') fail(403, 'الحساب موقوف.');
  const write = request.method !== 'GET';
  if (!user.development_access && user.must_change_password && user.temporary_password_expires <= Date.now()) fail(401, 'انتهت صلاحية كلمة المرور المؤقتة. راجع الإدارة.');
  if (!user.development_access && user.must_change_password && path !== 'password') fail(403, 'يجب تغيير كلمة المرور المؤقتة أولًا.');
  if (path === 'profile') {
    if (write) await run(env, 'UPDATE users SET name=?,subject=?,bio=? WHERE id=?', field(body.name, 100), field(body.subject, 100, 0), field(body.bio, 2000, 0), user.id);
    return { user: publicUser({ ...await one(env, 'SELECT * FROM users WHERE id=?', user.id), development_access: user.development_access }) };
  }
  if (path === 'password' && write) {
    const old = field(body.current, 128, 12), next = field(body.password, 128, 12);
    if (!equal(await passwordHash(old, user.password.split(':')[0]), user.password)) fail(400, 'كلمة المرور الحالية غير صحيحة.');
    if (old === next) fail(400, 'اختر كلمة مرور مختلفة عن الحالية.');
    const result = await env.DB.batch([statement(env, 'UPDATE users SET password=?,must_change_password=0,temporary_password_expires=NULL WHERE id=? AND password=?', await passwordHash(next), user.id, user.password), statement(env, 'DELETE FROM sessions WHERE user_id=?', user.id)]);
    if (!result[0].meta.changes) fail(409, 'تغيرت بيانات الحساب. سجّل الدخول مجددًا.');
    return { ok: true };
  }
  if (user.status !== 'active') fail(403, 'طلب انضمامك بانتظار موافقة الإدارة.');
  if (path === 'reminders' && !write && user.role !== 'admin') {
    const ownerColumn = user.role === 'teachers' ? 's.teacher_id' : 'b.student_id';
    return { bookings: await all(env, `${bookingSelect} WHERE ${ownerColumn}=? AND b.status='confirmed' AND s.start>=? AND s.start<=? ORDER BY s.start LIMIT 100`, user.id, Date.now() - 300000, Date.now() + 86400000) };
  }
  if (path === 'overview' && !write) {
    const where = user.role === 'admin' ? '' : user.role === 'teachers' ? ' WHERE s.teacher_id=?' : ' WHERE b.student_id=?';
    return { bookings: await all(env, `${bookingSelect}${where} ORDER BY s.start DESC LIMIT 500`, ...(where ? [user.id] : [])) };
  }
  if (path === 'users' && user.role === 'admin' && !write) return { users: (await all(env, 'SELECT * FROM users ORDER BY created DESC LIMIT 1000')).map(publicUser) };
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
    if (!['active', 'suspended'].includes(body.status)) fail(400, 'حالة غير صحيحة.');
    const target = await one(env, "SELECT * FROM users WHERE id=? AND role!='admin'", id);
    if (!target) fail(404, 'الحساب غير موجود.');
    await env.DB.batch([statement(env, 'UPDATE users SET status=? WHERE id=?', body.status, id), statement(env, 'DELETE FROM sessions WHERE user_id=?', id), auditEntry(env, user.id, `user:${body.status}`, id)]);
    return { ok: true };
  }
  if (path === 'audit' && user.role === 'admin' && !write) return { events: await all(env, 'SELECT a.*,u.name FROM audit a JOIN users u ON u.id=a.actor ORDER BY a.created DESC LIMIT 100') };
  if (path === 'slots') {
    if (!write) {
      if (user.role === 'teachers') return { slots: await all(env, 'SELECT * FROM slots WHERE teacher_id=? ORDER BY start DESC LIMIT 500', user.id) };
      return { slots: await all(env, `SELECT s.*,u.name AS teacher_name,u.bio FROM slots s JOIN users u ON u.id=s.teacher_id WHERE s.status='open' AND u.status='active' AND s.start>? ORDER BY s.start LIMIT 500`, Date.now()) };
    }
    if (user.role !== 'teachers') fail(403, 'إضافة المواعيد متاحة للأستاذ فقط.');
    const start = Number(body.start), minutes = Number(body.minutes), price = Number(body.price);
    if (!Number.isSafeInteger(start) || start <= Date.now() || start > Date.now() + 31536000000 || ![30, 45, 60, 90, 120].includes(minutes) || !Number.isInteger(price) || price < 0 || price > 100000) fail(400, 'تحقق من الموعد والمدة والسعر.');
    const result = await run(env, `INSERT INTO slots (id,teacher_id,start,minutes,price,subject) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM slots WHERE teacher_id=? AND status!='cancelled' AND start<? AND start+minutes*60000>?)`, crypto.randomUUID(), user.id, start, minutes, price, field(body.subject, 100), user.id, start + minutes * 60000, start);
    if (!result.meta.changes) fail(409, 'الموعد يتداخل مع موعد آخر.');
    return { ok: true };
  }
  if (path.startsWith('slots/') && write) {
    const id = path.split('/')[1];
    if (user.role === 'teachers') {
      const r = await run(env, "UPDATE slots SET status='cancelled' WHERE id=? AND teacher_id=? AND status='open'", id, user.id);
      if (!r.meta.changes) fail(409, 'تعذر حذف الموعد؛ ربما تم حجزه.');
      return { ok: true };
    }
    if (user.role !== 'students') fail(403, 'الحجز متاح للطلاب فقط.');
    const bookingId = crypto.randomUUID();
    // Claiming the slot and inserting the reservation are one serialized D1 transaction.
    const results = await env.DB.batch([
      statement(env, `INSERT INTO bookings (id,slot_id,student_id,status,room,created) SELECT ?,s.id,?,'confirmed',?,? FROM slots s JOIN users t ON t.id=s.teacher_id WHERE s.id=? AND s.status='open' AND s.start>? AND t.status='active' AND NOT EXISTS (SELECT 1 FROM bookings b JOIN slots x ON x.id=b.slot_id WHERE b.student_id=? AND b.status='confirmed' AND x.start<s.start+s.minutes*60000 AND x.start+x.minutes*60000>s.start)`, bookingId, user.id, random(), Date.now(), id, Date.now(), user.id),
      statement(env, "UPDATE slots SET status='booked' WHERE id=? AND EXISTS (SELECT 1 FROM bookings WHERE id=?)", id, bookingId),
    ]);
    if (!results[0].meta.changes) fail(409, 'الموعد لم يعد متاحًا أو يتداخل مع إحدى حصصك.');
    return { ok: true, id: bookingId };
  }
  const [category, id, action] = path.split('/');
  if (category === 'bookings' && id) {
    const row = await booking(env, id, user);
    if (action === 'room' && !write) {
      if (user.role === 'admin' || row.status !== 'confirmed') fail(403, 'الغرفة متاحة فقط لطرفي الحصة المؤكدة.');
      const now = Date.now();
      if (now < row.start - 900000 || now > row.start + row.minutes * 60000 + 1800000) fail(403, 'تفتح الغرفة قبل الموعد بربع ساعة وتغلق بعد نهايته بنصف ساعة.');
      const otherId = user.role === 'teachers' ? row.student_id : row.teacher_id;
      if (!(await one(env, "SELECT id FROM users WHERE id=? AND status='active'", otherId))) fail(403, 'حساب الطرف الآخر غير نشط.');
      return { room: (await one(env, 'SELECT room FROM bookings WHERE id=?', id)).room, role: user.role === 'teachers' ? 'teacher' : 'student' };
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
      if (user.role !== 'admin' && row.start <= Date.now()) fail(409, 'راجع الإدارة لإلغاء حصة بدأ موعدها.');
      await env.DB.batch([
        statement(env, "UPDATE bookings SET status='cancelled',room=? WHERE id=? AND status='confirmed'", random(), id),
        statement(env, "UPDATE slots SET status='open' WHERE id=? AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='cancelled') AND NOT EXISTS(SELECT 1 FROM bookings WHERE slot_id=? AND status='confirmed')", row.slot_id, id, row.slot_id),
        auditEntry(env, user.id, 'booking:cancel', id),
      ]);
      return { ok: true };
    }
    if (action === 'complete' && write && user.role === 'teachers') {
      if (row.start + row.minutes * 60000 > Date.now()) fail(409, 'يمكن إكمال الحصة بعد انتهاء موعدها.');
      const r = await run(env, "UPDATE bookings SET status='completed',room=? WHERE id=? AND status='confirmed'", random(), id);
      if (!r.meta.changes) fail(409, 'الحصة ليست مؤكدة.');
      return { ok: true };
    }
    if (action === 'notes' && write && user.role === 'teachers') {
      const resource = field(body.resource, 1000, 0);
      if (resource) { let url; try { url = new URL(resource); } catch { fail(400, 'رابط المادة غير صحيح.'); } if (url.protocol !== 'https:') fail(400, 'استخدم رابط HTTPS للمادة.'); }
      if (row.status === 'cancelled') fail(409, 'الحصة ملغاة.');
      await run(env, 'UPDATE bookings SET notes=?,resource=? WHERE id=?', field(body.notes, 5000, 0), resource, id);
      return { ok: true };
    }
    if (action === 'payment' && write && user.role === 'admin') {
      if (![0, 1].includes(body.paid)) fail(400, 'حالة دفع غير صحيحة.');
      await env.DB.batch([statement(env, 'UPDATE bookings SET paid=?,payment_ref=? WHERE id=?', body.paid, field(body.reference, 200, body.paid ? 1 : 0), id), auditEntry(env, user.id, body.paid ? 'payment:received' : 'payment:reversed', id)]);
      return { ok: true };
    }
  }
  fail(404, 'الطلب غير موجود أو غير متاح لحسابك.');
}
