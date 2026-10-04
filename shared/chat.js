export const chatDefaults = { readReceipts: true, showPresence: true, notifications: true, sounds: false };
export const quickReactions = ['❤️', '👍', '😂', '🔥', '👏', '🎉'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length <= max ? value.trim() : fail(400, 'النص أطول من المسموح أو غير صالح.');
export function gifUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !/^(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com)$/.test(url.hostname) || !url.pathname.endsWith('.gif')) throw new Error();
    return url.href;
  } catch { fail(400, 'استخدم رابط GIF مباشر وآمن من Giphy أو Tenor.'); }
}
export async function ensureChat(store, teacherId, studentId) {
  const id = `dm-${teacherId}-${studentId}`;
  await store.ensureConversation({ id, teacher_id: teacherId, student_id: studentId, created: Date.now() });
  return id;
}
export async function syncChats(store, user) {
  if ((await store.settings(user.id)).backfilled) return;
  const pairs = await store.relationships(user);
  for (const pair of pairs) await ensureChat(store, pair.teacher_id, pair.student_id);
  await store.saveSettings(user.id, { backfilled: true });
}
const otherId = (thread, user) => thread.teacher_id === user.id ? thread.student_id : thread.teacher_id;
const visiblePresence = (settings, blocked) => {
  if (!settings.showPresence || blocked) return { status: 'hidden', lastSeen: null };
  const elapsed = Date.now() - (settings.last_seen || 0);
  return { status: settings.active && elapsed < 45000 ? 'online' : elapsed < 300000 ? 'away' : 'offline', lastSeen: settings.last_seen || null };
};
async function participants(store, thread, user) {
  const peerId = otherId(thread, user);
  const [mine, theirs, settings, peerSettings, peer] = await Promise.all([
    store.member(thread.id, user.id), store.member(thread.id, peerId), store.settings(user.id), store.settings(peerId), store.user(peerId),
  ]);
  return { mine, theirs, settings, peerSettings, peer, peerId };
}
function threadInfo(thread, p) {
  const blocked = Boolean(p.mine.blocked || p.theirs.blocked);
  return {
    id: thread.id, created: thread.created,
    peer: { id: p.peerId, name: p.peer?.name || 'حساب غير متاح', role: p.peer?.role, ...visiblePresence(p.peerSettings, blocked) },
    muted: Boolean(p.mine.muted), blocked: Boolean(p.mine.blocked), unavailable: blocked || p.peer?.status !== 'active', hidden: Boolean(p.mine.hidden),
    historyAfter: p.mine.deleted_at || 0,
    peerReadAt: p.peerSettings.readReceipts && !blocked ? p.theirs.read_at || 0 : null,
    typing: !blocked && Number(p.theirs.typing_until) > Date.now(),
  };
}
async function serializeMessages(store, rows, p, user) {
  const reactions = await store.reactions(rows.map(row => row.id));
  const replies = await Promise.all(rows.map(row => row.reply_to ? store.message(row.reply_to) : null));
  return rows.map((row, index) => ({
    id: row.id, author_id: row.author_id, body: row.body, media_url: row.media_url || '', created: row.created,
    reply: replies[index] && replies[index].thread_id === row.thread_id && replies[index].created > (p.mine.deleted_at || 0) ? { id: replies[index].id, body: replies[index].body, media_url: replies[index].media_url, author_id: replies[index].author_id } : null,
    reactions: quickReactions.flatMap(emoji => {
      const matches = reactions.filter(r => r.message_id === row.id && r.emoji === emoji);
      return matches.length ? [{ emoji, count: matches.length, mine: matches.some(r => r.user_id === user.id) }] : [];
    }),
  }));
}
// This contract is used by both the MongoDB service and the D1 worker.
export async function handleChat({ store, user, path, write, body = {}, query = {} }) {
  if (!['students', 'teachers'].includes(user.role)) fail(403, 'المراسلة متاحة للطالب والأستاذ فقط.');
  const settings = () => store.settings(user.id);
  if (path === 'chat/settings') {
    if (write) {
      const changes = {};
      for (const key of Object.keys(chatDefaults)) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== 'boolean') fail(400, 'إعداد غير صالح.');
          changes[key] = body[key];
        }
      }
      await store.saveSettings(user.id, changes);
    }
    const peers = write ? (await store.conversations(user.id)).map(thread => otherId(thread, user)) : [];
    return { data: { settings: await settings() }, notify: write ? [user.id, ...new Set(peers)] : [] };
  }
  if (path === 'chat/presence' && write) {
    if (typeof body.active !== 'boolean') fail(400, 'حالة الاتصال غير صالحة.');
    const previous = await settings();
    await store.saveSettings(user.id, { active: body.active, ...(body.active || previous.active ? { last_seen: Date.now() } : {}) });
    return { data: { ok: true }, notify: [] };
  }
  if (path === 'chat/threads' && !write) {
    await syncChats(store, user);
    const rows = await store.conversations(user.id);
    const threads = await Promise.all(rows.map(async row => {
      const p = await participants(store, row, user);
      const summary = await store.summary(row.id, user.id, Math.max(p.mine.deleted_at || 0, p.mine.read_at || 0), p.mine.deleted_at || 0);
      return { ...threadInfo(row, p), unread: summary.unread, lastMessage: summary.last ? { id: summary.last.id, body: summary.last.body, media_url: summary.last.media_url, created: summary.last.created, author_id: summary.last.author_id } : null };
    }));
    threads.sort((a, b) => (b.lastMessage?.created || b.created) - (a.lastMessage?.created || a.created));
    return { data: { threads, settings: await settings() }, notify: [] };
  }
  const match = /^chat\/threads\/([^/]+)(?:\/(messages|read|typing|preferences|delete|restore|reaction))?$/.exec(path);
  if (!match) fail(404, 'الطلب غير موجود.');
  const [, id, action] = match;
  const thread = await store.conversation(id);
  if (!thread || ![thread.teacher_id, thread.student_id].includes(user.id)) fail(404, 'المحادثة غير موجودة.');
  const p = await participants(store, thread, user);
  const notify = [user.id, p.peerId];
  if (!action && !write) {
    const before = Number(query.before || 0);
    if (!Number.isSafeInteger(before) || before < 0) fail(400, 'طلب غير صالح.');
    const rows = await store.messages(id, p.mine.deleted_at || 0, before, String(query.beforeId || ''));
    const hasMore = rows.length > 50;
    const page = rows.slice(0, 50).reverse();
    return { data: { thread: threadInfo(thread, p), messages: await serializeMessages(store, page, p, user), hasMore }, notify: [] };
  }
  if (action === 'preferences' && write) {
    const changes = {};
    for (const key of ['muted', 'blocked']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') fail(400, 'إعداد غير صالح.');
        changes[key] = body[key] ? 1 : 0;
      }
    }
    if (body.blocked === true) changes.typing_until = 0;
    await store.updateMember(id, user.id, changes);
    return { data: { ok: true }, notify };
  }
  if (action === 'delete' && write) {
    const summary = await store.summary(id, user.id, 0, 0);
    await store.updateMember(id, user.id, { hidden: 1, deleted_at: Math.max(Date.now(), summary.last?.created || 0), typing_until: 0 });
    return { data: { ok: true }, notify: [user.id] };
  }
  if (action === 'restore' && write) {
    await store.updateMember(id, user.id, { hidden: 0 });
    return { data: { ok: true }, notify: [user.id] };
  }
  if (action === 'read' && write) {
    const message = await store.message(text(body.messageId, 100));
    if (!message || message.thread_id !== id || message.created <= (p.mine.deleted_at || 0)) fail(404, 'الرسالة غير موجودة.');
    await store.markRead(id, user.id, message.created);
    return { data: { ok: true }, notify };
  }
  if (p.mine.blocked || p.theirs.blocked || p.peer?.status !== 'active') fail(403, 'المراسلة غير متاحة في هذه المحادثة حالياً.');
  if (action === 'typing' && write) {
    if (typeof body.active !== 'boolean') fail(400, 'حالة الكتابة غير صالحة.');
    await store.updateMember(id, user.id, { typing_until: body.active === true ? Date.now() + 3500 : 0 });
    return { data: { ok: true }, notify };
  }
  if (action === 'reaction' && write) {
    if (!quickReactions.includes(body.emoji)) fail(400, 'اختر أحد التفاعلات المتاحة.');
    const message = await store.message(text(body.messageId, 100));
    if (!message || message.thread_id !== id || message.created <= (p.mine.deleted_at || 0)) fail(404, 'الرسالة غير موجودة.');
    await store.setReaction(message.id, user.id, body.emoji, body.active === true);
    return { data: { ok: true, message: (await serializeMessages(store, [message], p, user))[0] }, notify };
  }
  if (action === 'messages' && write) {
    const messageId = text(body.id, 100);
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) fail(400, 'معرّف الرسالة غير صالح.');
    const existing = await store.message(messageId);
    if (existing) {
      if (existing.thread_id !== id || existing.author_id !== user.id) fail(409, 'معرّف الرسالة مستخدم.');
      return { data: { message: (await serializeMessages(store, [existing], p, user))[0] }, notify: [] };
    }
    const messageBody = text(body.body || '');
    const media = body.media_url ? gifUrl(text(body.media_url, 1000)) : '';
    if (!messageBody && !media) fail(400, 'اكتب رسالة أو اختر GIF.');
    const replyId = text(body.reply_to || '', 100);
    if (replyId) {
      const reply = await store.message(replyId);
      if (!reply || reply.thread_id !== id || reply.created <= (p.mine.deleted_at || 0)) fail(404, 'الرسالة الأصلية غير موجودة.');
    }
    const message = { id: messageId, thread_id: id, author_id: user.id, body: messageBody, media_url: media, reply_to: replyId, created: Math.max(Date.now(), (p.mine.deleted_at || 0) + 1, (p.theirs.deleted_at || 0) + 1) };
    await store.insertMessage(message);
    await Promise.all([store.updateMember(id, user.id, { hidden: 0, typing_until: 0 }), store.updateMember(id, p.peerId, { hidden: 0 })]);
    return { data: { message: (await serializeMessages(store, [message], p, user))[0] }, notify, threadId: id };
  }
  fail(404, 'الطلب غير موجود.');
}
