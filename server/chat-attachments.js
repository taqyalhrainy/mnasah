import { GridFSBucket } from 'mongodb';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mongoChatStore } from './chat-store.js';
import { attachmentFail as fail, attachmentHeaders, attachmentAccess, uploadMetadata, prepareUpload, publicAttachment, downloadAttachment, previewType, cleanupAttachments, byteRange } from '../shared/chat-attachments.js';

export function gridAttachmentBytes(db) {
  const bucket = new GridFSBucket(db, { bucketName: 'chat_files', chunkSizeBytes: 255 * 1024 });
  return {
    write: (id, name, source) => pipeline(Readable.from(source), bucket.openUploadStreamWithId(id, name)),
    read: (id, range = null) => bucket.openDownloadStream(id, range ? { start: range.start, end: range.end + 1 } : undefined),
    async remove(id) { try { await bucket.delete(id); } catch (error) { if (!/File not found/.test(error.message)) throw error; } },
  };
}
const activeUploads = new Map();
let lastCleanup = 0;
export async function serveChatAttachment(req, res, { db, user, path, bytes = gridAttachmentBytes(db) }) {
  const match = /^chat\/threads\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;
  const [, threadId, attachmentId] = match;
  const store = mongoChatStore(db);
  res.setHeader('Cache-Control', 'private, no-store');
  if (attachmentId && req.method === 'GET') {
    const file = await downloadAttachment(store, user, threadId, attachmentId);
    const preview = req.query.preview === '1';
    const range = preview && file.preview_type ? byteRange(req.headers.range, file.size) : null;
    if (range) res.statusCode = 206;
    res.set(attachmentHeaders(file, preview, range));
    const stream = bytes.read(file.id, range);
    // A closed browser cancels only this download, not any media/chat session.
    res.once('close', () => stream.destroy());
    stream.on('error', error => { console.error('Attachment download failed:', error.message); res.destroy(); });
    stream.pipe(res);
    return true;
  }
  if (attachmentId || req.method !== 'POST') fail(405, 'طريقة غير مدعومة.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع الملف بصيغته الأصلية.');
  const file = uploadMetadata(req.query, user, threadId);
  if (req.headers['content-length'] && Number(req.headers['content-length']) !== file.size) fail(400, 'حجم الملف لا يطابق البيانات المرسلة.');
  if ((activeUploads.get(user.id) || 0) >= 2 || [...activeUploads.values()].reduce((a, b) => a + b, 0) >= 8) fail(429, 'هناك ملفات قيد الرفع. انتظر انتهاء الرفع ثم حاول مجدداً.');
  activeUploads.set(user.id, (activeUploads.get(user.id) || 0) + 1);
  try {
    if (Date.now() - lastCleanup > 3600000) {
      lastCleanup = Date.now();
      await cleanupAttachments(store, id => bytes.remove(id));
    }
    await prepareUpload(store, user, threadId, file);
    await store.saveAttachment(file);
    let received = 0;
    const prefix = [];
    async function* source() {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        received += chunk.length;
        if (received > file.size) fail(413, 'حجم الملف أكبر من المسموح أو لا يطابق حجمه المعلن.');
        for (let index = 0; index < chunk.length && prefix.length < 32; index++) prefix.push(chunk[index]);
        yield chunk;
      }
      if (received !== file.size) fail(400, 'لم يكتمل رفع الملف. حاول مجدداً.');
    }
    try {
      await bytes.write(file.id, file.name, source());
      // Recheck after a slow upload in case the peer blocked the conversation.
      await attachmentAccess(store, user, threadId, true);
      file.preview_type = previewType(Uint8Array.from(prefix), file.declared_type);
      await store.updateAttachment(file.id, { ready: 1, preview_type: file.preview_type });
    } catch (error) {
      await bytes.remove(file.id).catch(() => undefined);
      await store.removeAttachment(file.id);
      req.resume();
      throw error;
    }
    res.json({ attachment: publicAttachment(file) });
    return true;
  } finally {
    const count = (activeUploads.get(user.id) || 1) - 1;
    if (count) activeUploads.set(user.id, count); else activeUploads.delete(user.id);
  }
}
