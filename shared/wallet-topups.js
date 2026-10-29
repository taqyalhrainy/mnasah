import { imageType } from './chat-attachments.js';

export const MAX_TOPUP_PROOF_BYTES = 5 * 1024 * 1024;
export const publicTopup = row => ({
  id: row.id,
  user_id: row.user_id,
  user_name: row.user_name || '',
  user_email: row.user_email || '',
  amount: Number(row.amount),
  status: row.status,
  transfer_reference: row.transfer_reference || '',
  proof_name: row.proof_name,
  proof_type: row.proof_type,
  created: Number(row.created),
  reviewed_at: Number(row.reviewed_at || 0),
  reviewed_by: row.reviewed_by || '',
  rejection_reason: row.rejection_reason || '',
});

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function topupMetadata(query, userId) {
  const amount = Math.round(Number(query.amount) * 100);
  if (!Number.isInteger(amount) || amount < 100 || amount > 1000000) fail(400, 'أدخل مبلغاً بين 1 و10,000 دينار.');
  const name = typeof query.name === 'string' ? query.name.trim().replace(/[\u0000-\u001f\u007f/\\]/g, '_') : '';
  if (!name || name.length > 255) fail(400, 'اسم صورة الحوالة غير صالح.');
  const size = Number(query.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_TOPUP_PROOF_BYTES) fail(413, 'صورة الحوالة يجب ألا تتجاوز 5 ميغابايت.');
  const declaredType = typeof query.type === 'string' && /^image\/(?:png|jpeg|webp)$/.test(query.type) ? query.type : '';
  if (!declaredType) fail(415, 'ارفع صورة PNG أو JPG أو WEBP.');
  const reference = typeof query.reference === 'string' ? query.reference.trim() : '';
  if (reference.length > 100) fail(400, 'رقم الحوالة أطول من المسموح.');
  return { id: crypto.randomUUID(), user_id: userId, amount, status: 'pending', transfer_reference: reference, proof_name: name, proof_size: size, declared_type: declaredType, created: Date.now(), reviewed_at: 0, reviewed_by: '', rejection_reason: '' };
}

export function verifiedTopupImage(prefix, declaredType) {
  const actual = imageType(prefix);
  if (!actual || actual !== declaredType) fail(415, 'محتوى صورة الحوالة لا يطابق نوع الملف.');
  return actual;
}

export function paymentSettings(value) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = {}; } }
  return { cliq_alias: String(parsed?.cliq_alias || ''), cliq_name: String(parsed?.cliq_name || 'تقي الله الهريني'), support_whatsapp: String(parsed?.support_whatsapp || '0795764229') };
}
