import { all, one, run, statement } from './db.js';
import { attachmentHeaders } from '../shared/chat-attachments.js';
import { verificationFileMeta, verifiedContentType } from '../shared/verification-files.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const CHUNK_BYTES = 1024 * 1024;
export async function workerVerificationFile(request, env, user, path) {
  const match = /^verification\/files(?:\/([^/]+))?$/.exec(path);
  if (!match) return null;
  const fileId = match[1];
  if (fileId && request.method === 'GET') {
    const file = await one(env, 'SELECT * FROM verification_files WHERE id=?', fileId);
    if (!file || (user.role !== 'admin' && file.user_id !== user.id)) fail(404, 'ملف التحقق غير موجود.');
    let position = 0;
    const stream = new ReadableStream({ async pull(controller) { try { const row = await one(env, 'SELECT data FROM verification_file_chunks WHERE file_id=? AND position=?', file.id, position++); if (!row) return controller.close(); controller.enqueue(row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)); } catch (error) { controller.error(error); } } });
    return new Response(stream, { headers: attachmentHeaders({ ...file, preview_type: file.content_type }, new URL(request.url).searchParams.get('preview') === '1') });
  }
  if (fileId || request.method !== 'POST' || user.role !== 'teachers') fail(405, 'طريقة غير مدعومة.');
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const meta = verificationFileMeta(Object.fromEntries(new URL(request.url).searchParams)); meta.user_id = user.id;
  if (request.headers.has('content-length') && Number(request.headers.get('content-length')) !== meta.size) fail(400, 'حجم الملف لا يطابق البيانات المرسلة.');
  if (meta.kind === 'credential' && Number((await one(env, "SELECT COUNT(*) AS count FROM verification_files WHERE user_id=? AND kind='credential'", user.id))?.count || 0) >= 5) fail(413, 'يمكن رفع خمسة مستندات داعمة كحد أقصى.');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'اختر ملفاً غير فارغ.');
  const chunks = []; const prefix = []; let received = 0, piece = new Uint8Array(CHUNK_BYTES), used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break; received += value.length; if (received > meta.size) fail(413, 'حجم الملف أكبر من المعلن.');
      for (let index = 0; index < value.length && prefix.length < 32; index++) prefix.push(value[index]);
      for (let offset = 0; offset < value.length;) { const count = Math.min(value.length - offset, CHUNK_BYTES - used); piece.set(value.subarray(offset, offset + count), used); used += count; offset += count; if (used === CHUNK_BYTES) { chunks.push(piece); piece = new Uint8Array(CHUNK_BYTES); used = 0; } }
    }
    if (received !== meta.size) fail(400, 'لم يكتمل رفع الملف.'); if (used) chunks.push(piece.subarray(0, used));
    meta.content_type = verifiedContentType(meta.kind, Uint8Array.from(prefix), meta.declared_type); if (!meta.content_type) fail(415, 'محتوى الملف لا يطابق نوعه.');
    const old = meta.kind === 'credential' ? [] : await all(env, 'SELECT id FROM verification_files WHERE user_id=? AND kind=?', user.id, meta.kind);
    await env.DB.batch([
      ...old.flatMap(file => [statement(env, 'DELETE FROM verification_file_chunks WHERE file_id=?', file.id), statement(env, 'DELETE FROM verification_files WHERE id=?', file.id)]),
      statement(env, 'INSERT INTO verification_files (id,user_id,kind,name,size,content_type,created) VALUES (?,?,?,?,?,?,?)', meta.id, user.id, meta.kind, meta.name, meta.size, meta.content_type, meta.created),
      ...chunks.map((data, index) => statement(env, 'INSERT INTO verification_file_chunks (file_id,position,data) VALUES (?,?,?)', meta.id, index, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))),
    ]);
    return { file: { id: meta.id, kind: meta.kind, name: meta.name, size: meta.size, content_type: meta.content_type } };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function workerPublicAvatar(env, userId) {
  const file = await one(env, "SELECT f.* FROM verification_files f JOIN users u ON u.id=f.user_id WHERE f.user_id=? AND f.kind='avatar' AND u.role='teachers' AND u.status='active' ORDER BY f.created DESC LIMIT 1", userId);
  if (!file) fail(404, 'الصورة غير موجودة.'); let position = 0;
  const stream = new ReadableStream({ async pull(controller) { try { const row = await one(env, 'SELECT data FROM verification_file_chunks WHERE file_id=? AND position=?', file.id, position++); if (!row) return controller.close(); controller.enqueue(row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)); } catch (error) { controller.error(error); } } });
  return new Response(stream, { headers: attachmentHeaders({ ...file, preview_type: file.content_type }, true) });
}
