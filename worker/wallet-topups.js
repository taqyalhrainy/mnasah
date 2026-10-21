import { all, one, statement } from './db.js';
import { attachmentHeaders } from '../shared/chat-attachments.js';
import { publicTopup, topupMetadata, verifiedTopupImage } from '../shared/wallet-topups.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const CHUNK_BYTES = 1024 * 1024;

export async function workerWalletTopup(request, env, user, path) {
  const proof = /^wallet\/topups\/([^/]+)\/proof$/.exec(path);
  if (proof && request.method === 'GET') {
    const row = await one(env, 'SELECT * FROM wallet_topups WHERE id=?', proof[1]);
    if (!row || (user.role !== 'admin' && row.user_id !== user.id)) fail(404, 'صورة الحوالة غير موجودة.');
    let position = 0;
    const stream = new ReadableStream({ async pull(controller) { try { const chunk = await one(env, 'SELECT data FROM wallet_topup_chunks WHERE topup_id=? AND position=?', row.id, position++); if (!chunk) return controller.close(); controller.enqueue(chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data)); } catch (error) { controller.error(error); } } });
    return new Response(stream, { headers: attachmentHeaders({ name: row.proof_name, size: row.proof_size, preview_type: row.proof_type }, true) });
  }
  if (path !== 'wallet/topups') return null;
  if (request.method !== 'POST' || user.role !== 'students') fail(405, 'طريقة غير مدعومة.');
  const settings = await one(env, "SELECT value FROM platform_settings WHERE key='payments'");
  let payment = {}; try { payment = JSON.parse(settings?.value || '{}'); } catch { /* invalid configuration is treated as disabled */ }
  if (!payment.cliq_alias) fail(503, 'الدفع عبر كليك غير مفعّل بعد.');
  const meta = topupMetadata(Object.fromEntries(new URL(request.url).searchParams), user.id);
  const reader = request.body?.getReader(); if (!reader) fail(400, 'اختر صورة حوالة غير فارغة.');
  const chunks = []; let received = 0, piece = new Uint8Array(CHUNK_BYTES), used = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; received += value.length; if (received > meta.proof_size) fail(413, 'صورة الحوالة أكبر من الحجم المعلن.'); for (let offset = 0; offset < value.length;) { const count = Math.min(value.length - offset, CHUNK_BYTES - used); piece.set(value.subarray(offset, offset + count), used); used += count; offset += count; if (used === CHUNK_BYTES) { chunks.push(piece); piece = new Uint8Array(CHUNK_BYTES); used = 0; } } }
    if (received !== meta.proof_size) fail(400, 'لم يكتمل رفع صورة الحوالة.'); if (used) chunks.push(piece.subarray(0, used));
    const joined = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    meta.proof_type = verifiedTopupImage(joined.subarray(0, 32), meta.declared_type); delete meta.declared_type;
    meta.proof_hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', joined))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (await one(env, 'SELECT id FROM wallet_topups WHERE proof_hash=?', meta.proof_hash)) fail(409, 'تم استخدام صورة الحوالة هذه في طلب سابق.');
    await env.DB.batch([
      statement(env, 'INSERT INTO wallet_topups (id,user_id,amount,status,transfer_reference,proof_name,proof_size,proof_type,proof_hash,created,reviewed_at,reviewed_by,rejection_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', meta.id, meta.user_id, meta.amount, meta.status, meta.transfer_reference, meta.proof_name, meta.proof_size, meta.proof_type, meta.proof_hash, meta.created, 0, '', ''),
      ...chunks.map((data, index) => statement(env, 'INSERT INTO wallet_topup_chunks (topup_id,position,data) VALUES (?,?,?)', meta.id, index, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))),
    ]);
    return { topup: publicTopup(meta) };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
