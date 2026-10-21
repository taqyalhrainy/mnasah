import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket } from 'mongodb';
import { attachmentHeaders } from '../shared/chat-attachments.js';
import { publicTopup, topupMetadata, verifiedTopupImage } from '../shared/wallet-topups.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function walletProofBytes(db) {
  const bucket = new GridFSBucket(db, { bucketName: 'wallet_topup_proofs', chunkSizeBytes: 255 * 1024 });
  return {
    write: (id, name, source) => pipeline(Readable.from(source), bucket.openUploadStreamWithId(id, name)),
    read: id => bucket.openDownloadStream(id),
    async remove(id) { try { await bucket.delete(id); } catch (error) { if (!/File not found/.test(error.message)) throw error; } },
  };
}

export async function serveWalletTopup(req, res, { db, user, path, bytes = walletProofBytes(db) }) {
  const proof = /^wallet\/topups\/([^/]+)\/proof$/.exec(path);
  if (proof && req.method === 'GET') {
    const row = await db.collection('wallet_topups').findOne({ id: proof[1] }, { projection: { _id: 0 } });
    if (!row || (user.role !== 'admin' && row.user_id !== user.id)) fail(404, 'صورة الحوالة غير موجودة.');
    res.set(attachmentHeaders({ name: row.proof_name, size: row.proof_size, preview_type: row.proof_type }, true));
    const stream = bytes.read(row.id); res.once('close', () => stream.destroy?.()); stream.on?.('error', () => res.destroy()); stream.pipe(res); return true;
  }
  if (path !== 'wallet/topups') return false;
  if (req.method !== 'POST' || user.role !== 'students') fail(405, 'طريقة غير مدعومة.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'ارفع صورة الحوالة بصيغتها الأصلية.');
  const settings = await db.collection('platform_settings').findOne({ key: 'payments' });
  if (!settings?.value?.cliq_alias) fail(503, 'الدفع عبر كليك غير مفعّل بعد.');
  const meta = topupMetadata(req.query, user.id);
  if (req.headers['content-length'] && Number(req.headers['content-length']) !== meta.proof_size) fail(400, 'حجم صورة الحوالة لا يطابق الملف المرسل.');
  const chunks = []; let received = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { received += chunk.length; if (received > meta.proof_size) fail(413, 'صورة الحوالة أكبر من الحجم المعلن.'); chunks.push(Buffer.from(chunk)); }
  if (received !== meta.proof_size) fail(400, 'لم يكتمل رفع صورة الحوالة.');
  const data = Buffer.concat(chunks); meta.proof_type = verifiedTopupImage(data.subarray(0, 32), meta.declared_type); delete meta.declared_type;
  meta.proof_hash = crypto.createHash('sha256').update(data).digest('hex');
  if (await db.collection('wallet_topups').findOne({ proof_hash: meta.proof_hash })) fail(409, 'تم استخدام صورة الحوالة هذه في طلب سابق.');
  await bytes.write(meta.id, meta.proof_name, [data]);
  try { await db.collection('wallet_topups').insertOne(meta); }
  catch (error) { await bytes.remove(meta.id); if (/duplicate/i.test(error.message)) fail(409, 'تم استخدام صورة الحوالة هذه في طلب سابق.'); throw error; }
  res.json({ topup: publicTopup(meta) }); return true;
}
