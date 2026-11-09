import crypto from 'node:crypto';
import { gridAttachmentBytes } from './chat-attachments.js';
import { attachmentHeaders } from '../shared/chat-attachments.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uploads = new Set();
export async function serveLessonFile(req, res, { db, user, path, bytes = gridAttachmentBytes(db) }) {
  const match = /^bookings\/([^/]+)\/files(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;
  const [, bookingId, fileId] = match;
  const booking = await db.collection('bookings').findOne({ id: bookingId });
  const slot = booking && await db.collection('slots').findOne({ id: booking.slot_id });
  if (!booking || !slot || ![slot.teacher_id, booking.student_id].includes(user.id)) fail(404, 'الملف غير موجود.');
  res.setHeader('Cache-Control', 'private, no-store');
  if (fileId && req.method === 'GET') {
    const file = await db.collection('lesson_files').findOne({ id: fileId, booking_id: bookingId, ready: true });
    if (!file) fail(404, 'الملف غير موجود.');
    const preview = req.query.preview === '1' && /^(?:image\/(?:png|jpeg|webp|gif|svg\+xml)|application\/pdf)$/.test(file.content_type);
    res.set(attachmentHeaders({ ...file, preview_type: file.content_type }, preview));
    if (preview && file.content_type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; sandbox");
    const stream = bytes.read(file.id);
    res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
    return true;
  }
  if (fileId || req.method !== 'POST' || user.id !== slot.teacher_id) fail(403, 'رفع ملفات الحصة متاح للأستاذ فقط.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const size = Number(req.query.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 100 * 1024 * 1024) fail(413, 'الحد الأقصى للملف 100 ميغابايت.');
  if (uploads.has(user.id)) fail(429, 'انتظر انتهاء رفع الملف الحالي.');
  uploads.add(user.id);
  const file = { id: crypto.randomUUID(), booking_id: bookingId, name: String(req.query.name || 'file').replace(/[\r\n]/g, '').slice(0, 250), size, content_type: String(req.query.type || 'application/octet-stream').slice(0, 100), ready: false, created: Date.now() };
  try {
    await db.collection('lesson_files').insertOne(file);
    let total = 0;
    async function* source() {
      for await (const chunk of req) { total += chunk.length; if (total > size) fail(413, 'حجم الملف لا يطابق الحجم المرسل.'); yield chunk; }
      if (total !== size) fail(400, 'لم يكتمل رفع الملف. حاول مرة أخرى.');
    }
    await bytes.write(file.id, file.name, source());
    await db.collection('lesson_files').updateOne({ id: file.id }, { $set: { ready: true } });
    res.json({ url: `/api/teachers/bookings/${bookingId}/files/${file.id}`, name: file.name, size });
  } catch (error) {
    await bytes.remove(file.id).catch(() => undefined);
    await db.collection('lesson_files').deleteOne({ id: file.id }); throw error;
  } finally { uploads.delete(user.id); }
  return true;
}
