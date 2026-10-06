import { all, one, run, statement } from './db.js';
import { sqlChatStore } from './chat-store.js';
import { attachmentFail as fail, uploadMetadata, prepareUpload, attachmentAccess, publicAttachment, imageType, downloadAttachment, attachmentHeaders, cleanupAttachments } from '../shared/chat-attachments.js';

const CHUNK_BYTES = 1024 * 1024;
export async function workerChatAttachment(request, env, user, path) {
  const match = /^chat\/threads\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(path);
  if (!match) return null;
  const [, threadId, attachmentId] = match;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const store = sqlChatStore(env);
  if (attachmentId && request.method === 'GET') {
    const file = await downloadAttachment(store, user, threadId, attachmentId);
    let position = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const row = await one(env, 'SELECT data FROM chat_file_chunks WHERE attachment_id=? AND position=?', file.id, position++);
          if (!row) { controller.close(); return; }
          controller.enqueue(row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data));
        } catch (error) { controller.error(error); }
      },
    });
    return new Response(stream, { headers: attachmentHeaders(file, query.preview === '1') });
  }
  if (attachmentId || request.method !== 'POST') fail(405, 'طريقة غير مدعومة.');
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const file = uploadMetadata(query, user, threadId);
  if (request.headers.has('content-length') && Number(request.headers.get('content-length')) !== file.size) fail(400, 'حجم الملف لا يطابق البيانات المرسلة.');
  await cleanupAttachments(store, id => run(env, 'DELETE FROM chat_file_chunks WHERE attachment_id=?', id));
  await prepareUpload(store, user, threadId, file);
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'اختر ملفاً غير فارغ.');
  const chunks = [];
  let received = 0;
  let piece = new Uint8Array(CHUNK_BYTES), used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      received += value.length;
      if (received > file.size) fail(413, 'حجم الملف أكبر من المسموح أو لا يطابق حجمه المعلن.');
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(value.length - offset, CHUNK_BYTES - used);
        piece.set(value.subarray(offset, offset + count), used); used += count; offset += count;
        if (used === CHUNK_BYTES) { chunks.push(piece); piece = new Uint8Array(CHUNK_BYTES); used = 0; }
      }
    }
    if (received !== file.size) fail(400, 'لم يكتمل رفع الملف. حاول مجدداً.');
    if (used) chunks.push(piece.subarray(0, used));
    await attachmentAccess(store, user, threadId, true);
    file.preview_type = imageType(chunks[0].subarray(0, 32));
    await env.DB.batch([
      statement(env, 'INSERT INTO chat_attachments (id,thread_id,author_id,message_id,name,size,preview_type,ready,created,expires_at) VALUES (?,?,?,?,?,?,?,1,?,?)', file.id, file.thread_id, file.author_id, file.message_id, file.name, file.size, file.preview_type, file.created, file.expires_at),
      ...chunks.map((data, index) => statement(env, 'INSERT INTO chat_file_chunks (attachment_id,position,data) VALUES (?,?,?)', file.id, index, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))),
    ]);
    return { attachment: publicAttachment(file) };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
