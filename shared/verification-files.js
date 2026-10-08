import { imageType, mediaType } from './chat-attachments.js';

export const verificationFileLimit = kind => kind === 'avatar' ? 5 * 1024 * 1024 : kind === 'intro_video' ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
export function verificationFileMeta(query) {
  const kind = String(query.kind || '');
  if (!['avatar', 'intro_video', 'credential'].includes(kind)) throw Object.assign(new Error('نوع ملف التحقق غير صالح.'), { status: 400 });
  const name = String(query.name || '').trim().replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255);
  const size = Number(query.size);
  const declaredType = String(query.type || '').toLowerCase();
  if (!name || !Number.isSafeInteger(size) || size < 1 || size > verificationFileLimit(kind)) throw Object.assign(new Error(kind === 'intro_video' ? 'فيديو التحقق يجب ألا يتجاوز 25 ميغابايت.' : 'ملف التحقق أكبر من المسموح.'), { status: 413 });
  if (kind === 'avatar' && !/^image\/(jpeg|png|webp)$/.test(declaredType)) throw Object.assign(new Error('صورة الحساب يجب أن تكون JPG أو PNG أو WebP.'), { status: 415 });
  if (kind === 'intro_video' && !/^video\/(webm|mp4|quicktime)$/.test(declaredType)) throw Object.assign(new Error('فيديو التحقق يجب أن يكون WebM أو MP4.'), { status: 415 });
  if (kind === 'credential' && !/^(application\/pdf|image\/(jpeg|png|webp))$/.test(declaredType)) throw Object.assign(new Error('المستندات الداعمة تقبل PDF أو الصور فقط.'), { status: 415 });
  return { id: crypto.randomUUID(), kind, name, size, declared_type: declaredType, created: Date.now() };
}
export function verifiedContentType(kind, bytes, declaredType) {
  if (kind === 'avatar') return imageType(bytes);
  if (kind === 'intro_video') return mediaType(bytes, declaredType).startsWith('video/') ? mediaType(bytes, declaredType) : '';
  if (imageType(bytes)) return imageType(bytes);
  const pdf = String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
  return pdf ? 'application/pdf' : '';
}
