import crypto from 'node:crypto';
import { gridAttachmentBytes } from './chat-attachments.js';
import { attachmentHeaders } from '../shared/chat-attachments.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uploads = new Map();
export async function serveLessonFile(req, res, { db, user, path, bytes = gridAttachmentBytes(db), access, collection = 'lesson_files', urlPrefix }) {
  const match = /^bookings\/([^/]+)\/files(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;
  const [, bookingId, fileId] = match;
  let canUpload = access?.canUpload;
  if (!access) {
    const booking = await db.collection('bookings').findOne({ id: bookingId });
    const slot = booking && await db.collection('slots').findOne({ id: booking.slot_id });
    if (!booking || !slot || ![slot.teacher_id, booking.student_id].includes(user.id)) fail(404, 'الملف غير موجود.');
    canUpload = user.id === slot.teacher_id;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (fileId && req.method === 'GET') {
    const file = await db.collection(collection).findOne({ id: fileId, booking_id: bookingId, ready: true });
    if (!file) fail(404, 'الملف غير موجود.');
    const preview = req.query.preview === '1' && /^(?:image\/(?:png|jpeg|webp|gif|svg\+xml)|application\/pdf)$/.test(file.content_type);
    res.set(attachmentHeaders({ ...file, preview_type: file.content_type }, preview));
    if (preview && file.content_type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; sandbox");
    const stream = bytes.read(file.id);
    res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
    return true;
  }
  const boardImage = req.query.scope === 'whiteboard';
  const contentType = String(req.query.type || 'application/octet-stream').slice(0, 100);
  if (fileId || req.method !== 'POST' || (!canUpload && !boardImage)) fail(403, 'رفع ملفات الحصة متاح للأستاذ فقط.');
  if (boardImage && !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) fail(415, 'اختر ملف صورة صالحاً.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const size = Number(req.query.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 100 * 1024 * 1024) fail(413, 'الحد الأقصى للملف 100 ميغابايت.');
  if (boardImage && size > 12 * 1024 * 1024) fail(413, 'الصورة أكبر من 12 ميغابايت.');
  if ((uploads.get(user.id) || 0) >= 2) fail(429, 'انتظر انتهاء رفع الملف الحالي.');
  uploads.set(user.id, (uploads.get(user.id) || 0) + 1);
  const file = { id: crypto.randomUUID(), booking_id: bookingId, uploaded_by: user.id, name: String(req.query.name || 'file').replace(/[\r\n]/g, '').slice(0, 250), size, content_type: contentType, ready: false, created: Date.now() };
  try {
    await db.collection(collection).insertOne(file);
    let total = 0;
    async function* source() {
      const head = []; let headSize = 0, checked = !boardImage;
      for await (const chunk of req) {
        total += chunk.length; if (total > size) fail(413, 'حجم الملف لا يطابق الحجم المرسل.');
        if (!checked) {
          head.push(chunk); headSize += chunk.length;
          if (headSize < 12) continue;
          const prefix = Buffer.concat(head);
          const valid = contentType === 'image/webp' ? prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP'
            : contentType === 'image/png' ? prefix.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
          if (!valid) fail(415, 'اختر ملف صورة صالحاً.');
          checked = true; yield prefix;
        } else yield chunk;
      }
      if (!checked) fail(415, 'اختر ملف صورة صالحاً.');
      if (total !== size) fail(400, 'لم يكتمل رفع الملف. حاول مرة أخرى.');
    }
    await bytes.write(file.id, file.name, source());
    await db.collection(collection).updateOne({ id: file.id }, { $set: { ready: true } });
    res.json({ url: `${urlPrefix || `/api/teachers/bookings/${bookingId}/files`}/${file.id}`, name: file.name, size });
  } catch (error) {
    await bytes.remove(file.id).catch(() => undefined);
    await db.collection(collection).deleteOne({ id: file.id }); throw error;
  } finally { const remaining = (uploads.get(user.id) || 1) - 1; if (remaining) uploads.set(user.id, remaining); else uploads.delete(user.id); }
  return true;
}
