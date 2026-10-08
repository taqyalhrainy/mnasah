import { GridFSBucket } from 'mongodb';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentHeaders } from '../shared/chat-attachments.js';
import { verificationFileMeta, verifiedContentType } from '../shared/verification-files.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uploads = new Map();
export function verificationBytes(db) {
  const bucket = new GridFSBucket(db, { bucketName: 'verification_media', chunkSizeBytes: 255 * 1024 });
  return {
    write: (id, name, source) => pipeline(Readable.from(source), bucket.openUploadStreamWithId(id, name)),
    read: id => bucket.openDownloadStream(id),
    async remove(id) { try { await bucket.delete(id); } catch (error) { if (!/File not found/.test(error.message)) throw error; } },
  };
}

export async function serveVerificationFile(req, res, { db, user, path }) {
  const match = /^verification\/files(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;
  const fileId = match[1];
  const bytes = verificationBytes(db);
  res.setHeader('Cache-Control', 'private, no-store');
  if (fileId && req.method === 'GET') {
    const file = await db.collection('verification_files').findOne({ id: fileId }, { projection: { _id: 0 } });
    if (!file || (user.role !== 'admin' && file.user_id !== user.id)) fail(404, 'ملف التحقق غير موجود.');
    res.set(attachmentHeaders({ ...file, preview_type: file.content_type }, req.query.preview === '1'));
    const stream = bytes.read(file.id); res.once('close', () => stream.destroy()); stream.on('error', error => { console.error('Verification download failed:', error.message); res.destroy(); }); stream.pipe(res); return true;
  }
  if (fileId || req.method !== 'POST' || user.role !== 'teachers') fail(405, 'طريقة غير مدعومة.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const meta = verificationFileMeta(req.query); meta.user_id = user.id;
  if (req.headers['content-length'] && Number(req.headers['content-length']) !== meta.size) fail(400, 'حجم الملف لا يطابق البيانات المرسلة.');
  if ((uploads.get(user.id) || 0) >= 2) fail(429, 'انتظر انتهاء رفع الملفات الحالية.');
  const credentials = meta.kind === 'credential' ? await db.collection('verification_files').countDocuments({ user_id: user.id, kind: 'credential' }) : 0;
  if (credentials >= 5) fail(413, 'يمكن رفع خمسة مستندات داعمة كحد أقصى.');
  uploads.set(user.id, (uploads.get(user.id) || 0) + 1);
  try {
    let received = 0; const prefix = [];
    async function* source() {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        received += chunk.length; if (received > meta.size) fail(413, 'حجم الملف أكبر من المعلن.');
        for (let index = 0; index < chunk.length && prefix.length < 32; index++) prefix.push(chunk[index]);
        yield chunk;
      }
      if (received !== meta.size) fail(400, 'لم يكتمل رفع الملف.');
    }
    await bytes.write(meta.id, meta.name, source());
    meta.content_type = verifiedContentType(meta.kind, Uint8Array.from(prefix), meta.declared_type);
    if (!meta.content_type) { await bytes.remove(meta.id); fail(415, 'محتوى الملف لا يطابق نوعه.'); }
    if (meta.kind !== 'credential') {
      const old = await db.collection('verification_files').find({ user_id: user.id, kind: meta.kind }).toArray();
      await Promise.all(old.map(file => bytes.remove(file.id)));
      await db.collection('verification_files').deleteMany({ user_id: user.id, kind: meta.kind });
    }
    await db.collection('verification_files').insertOne(meta);
    res.json({ file: { id: meta.id, kind: meta.kind, name: meta.name, size: meta.size, content_type: meta.content_type } }); return true;
  } finally {
    const count = (uploads.get(user.id) || 1) - 1; if (count) uploads.set(user.id, count); else uploads.delete(user.id);
  }
}
