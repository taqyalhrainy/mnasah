// Uploaded bytes never live in the web root. Every download checks the conversation.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
export const DRAFT_LIFETIME = 86400000;
export const attachmentFail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const publicAttachment = file => ({ id: file.id, name: file.name, size: file.size, preview_type: file.preview_type || '' });
export function messageAttachments(message) {
  return typeof message?.attachments === 'string' ? JSON.parse(message.attachments) : message?.attachments || [];
}
export async function attachmentAccess(store, user, threadId, sending = false) {
  if (!['students', 'teachers'].includes(user.role)) attachmentFail(403, 'المراسلة متاحة للطالب والأستاذ فقط.');
  const thread = await store.conversation(threadId);
  if (!thread || ![thread.teacher_id, thread.student_id].includes(user.id)) attachmentFail(404, 'المحادثة غير موجودة.');
  const peerId = thread.teacher_id === user.id ? thread.student_id : thread.teacher_id;
  const [mine, theirs, peer] = await Promise.all([store.member(threadId, user.id), store.member(threadId, peerId), store.user(peerId)]);
  if (!mine || !theirs) attachmentFail(404, 'المحادثة غير موجودة.');
  if (sending && (mine.hidden || mine.blocked || theirs.blocked || peer?.status !== 'active')) attachmentFail(403, 'المراسلة غير متاحة في هذه المحادثة حالياً.');
  return { mine, theirs };
}
export function uploadMetadata(query, user, threadId) {
  if (!uuid(query.messageId)) attachmentFail(400, 'معرّف الرسالة غير صالح.');
  const name = typeof query.name === 'string' ? query.name.trim().replace(/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/g, '_') : '';
  if (!name || name.length > 255) attachmentFail(400, 'اسم الملف غير صالح أو أطول من المسموح.');
  const size = Number(query.size);
  if (!Number.isSafeInteger(size) || size < 1) attachmentFail(400, 'اختر ملفاً غير فارغ.');
  if (size > MAX_FILE_BYTES) attachmentFail(413, 'الحد الأقصى للملف 25 ميغابايت.');
  return { id: crypto.randomUUID(), thread_id: threadId, author_id: user.id, message_id: query.messageId, name, size, preview_type: '', ready: 0, created: Date.now(), expires_at: Date.now() + DRAFT_LIFETIME };
}
// Only recognized raster formats may render inline; SVG/HTML and all other files download.
export function imageType(bytes) {
  const starts = values => values.every((value, index) => bytes[index] === value);
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return '';
}
export function attachmentHeaders(file, preview = false) {
  const inline = preview && Boolean(file.preview_type);
  return {
    'Content-Type': inline ? file.preview_type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
    'Content-Length': String(file.size), 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  };
}
export async function downloadAttachment(store, user, threadId, attachmentId) {
  const { mine } = await attachmentAccess(store, user, threadId);
  const file = await store.attachment(attachmentId);
  const message = file && await store.message(file.message_id);
  if (!file || file.thread_id !== threadId || !message || message.thread_id !== threadId || message.created <= (mine.deleted_at || 0) || !messageAttachments(message).some(row => row.id === file.id)) attachmentFail(404, 'الملف غير موجود.');
  return file;
}
export async function resolveAttachments(store, user, threadId, messageId, ids = []) {
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length || ids.some(id => !uuid(id))) attachmentFail(400, 'اختر حتى 10 مرفقات للرسالة.');
  const rows = await Promise.all(ids.map(id => store.attachment(id)));
  if (rows.some(row => !row || !row.ready || row.thread_id !== threadId || row.author_id !== user.id || row.message_id !== messageId || row.expires_at <= Date.now())) attachmentFail(400, 'أحد المرفقات غير صالح أو انتهت صلاحيته. أعد اختياره.');
  if (rows.reduce((total, row) => total + row.size, 0) > MAX_MESSAGE_BYTES) attachmentFail(413, 'حجم مرفقات الرسالة يجب ألا يتجاوز 100 ميغابايت.');
  return rows.map(publicAttachment);
}
export async function prepareUpload(store, user, threadId, file) {
  await attachmentAccess(store, user, threadId, true);
  if (await store.message(file.message_id)) attachmentFail(409, 'هذه الرسالة أُرسلت بالفعل. اختر رسالة جديدة للمرفق.');
  const usage = await store.recentAttachments(user.id, Date.now() - DRAFT_LIFETIME);
  if (usage.length >= 200 || usage.reduce((sum, row) => sum + row.size, 0) + file.size > 200 * 1024 * 1024) attachmentFail(429, 'وصلت إلى حد رفع الملفات اليومي (200 ميغابايت). حاول لاحقاً.');
  const pending = usage.filter(row => row.message_id === file.message_id);
  if (pending.length >= MAX_ATTACHMENTS || pending.reduce((sum, row) => sum + row.size, 0) + file.size > MAX_MESSAGE_BYTES) attachmentFail(413, 'الرسالة تسمح بـ10 ملفات وبحجم إجمالي 100 ميغابايت.');
}
export async function cleanupAttachments(store, removeBytes) {
  for (const file of await store.expiredAttachments(Date.now())) {
    const message = await store.message(file.message_id);
    if (messageAttachments(message).some(row => row.id === file.id)) await store.finalizeAttachments([file.id]);
    else { await removeBytes(file.id); await store.removeAttachment(file.id); }
  }
}
