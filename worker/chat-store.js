import { all, one, run } from './db.js';
import { chatDefaults } from '../shared/chat.js';

export function sqlChatStore(env) {
  return {
    relationships: user => all(env, `SELECT DISTINCT s.teacher_id,b.student_id FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE ${user.role === 'teachers' ? 's.teacher_id' : 'b.student_id'}=?`, user.id),
    async ensureConversation(thread) {
      await run(env, 'INSERT OR IGNORE INTO conversations (id,teacher_id,student_id,created) VALUES (?,?,?,?)', thread.id, thread.teacher_id, thread.student_id, thread.created);
      for (const id of [thread.teacher_id, thread.student_id]) await run(env, 'INSERT OR IGNORE INTO chat_members (thread_id,user_id) VALUES (?,?)', thread.id, id);
    },
    conversations: id => all(env, 'SELECT * FROM conversations WHERE teacher_id=? OR student_id=?', id, id),
    conversation: id => one(env, 'SELECT * FROM conversations WHERE id=?', id),
    member: (threadId, userId) => one(env, 'SELECT * FROM chat_members WHERE thread_id=? AND user_id=?', threadId, userId),
    updateMember: (threadId, userId, changes) => {
      const keys = Object.keys(changes);
      if (keys.length) return run(env, `UPDATE chat_members SET ${keys.map(key => `${key}=?`).join(',')} WHERE thread_id=? AND user_id=?`, ...Object.values(changes), threadId, userId);
    },
    markRead: (threadId, userId, time) => run(env, 'UPDATE chat_members SET read_at=MAX(read_at,?) WHERE thread_id=? AND user_id=?', time, threadId, userId),
    async settings(userId) { const row = await one(env, 'SELECT value FROM chat_settings WHERE user_id=?', userId); return { ...chatDefaults, ...(row ? JSON.parse(row.value) : {}) }; },
    async saveSettings(userId, changes) {
      await run(env, "INSERT OR IGNORE INTO chat_settings (user_id,value) VALUES (?, '{}')", userId);
      for (const [key, value] of Object.entries(changes)) await run(env, 'UPDATE chat_settings SET value=json_set(value,?,json(?)) WHERE user_id=?', `$.${key}`, JSON.stringify(value), userId);
    },
    user: id => one(env, 'SELECT id,name,role,status FROM users WHERE id=?', id),
    async summary(threadId, userId, readAt, deletedAt) {
      const last = await one(env, 'SELECT * FROM direct_messages WHERE thread_id=? AND created>? ORDER BY created DESC,id DESC LIMIT 1', threadId, deletedAt);
      const unread = await one(env, 'SELECT COUNT(*) AS count FROM direct_messages WHERE thread_id=? AND author_id!=? AND created>?', threadId, userId, readAt);
      return { last, unread: Number(unread.count) };
    },
    messages: (threadId, deletedAt, before, beforeId) => all(env, `SELECT * FROM direct_messages WHERE thread_id=? AND created>? ${before ? 'AND (created<? OR (created=? AND id<?))' : ''} ORDER BY created DESC,id DESC LIMIT 51`, threadId, deletedAt, ...(before ? [before, before, beforeId] : [])),
    message: id => one(env, 'SELECT * FROM direct_messages WHERE id=?', id),
    insertMessage: m => run(env, 'INSERT INTO direct_messages (id,thread_id,author_id,body,media_url,reply_to,created,attachments) VALUES (?,?,?,?,?,?,?,?)', m.id, m.thread_id, m.author_id, m.body, m.media_url, m.reply_to, m.created, JSON.stringify(m.attachments || [])),
    attachment: id => one(env, 'SELECT * FROM chat_attachments WHERE id=?', id),
    recentAttachments: (userId, since) => all(env, 'SELECT * FROM chat_attachments WHERE author_id=? AND created>? LIMIT 201', userId, since),
    expiredAttachments: now => all(env, 'SELECT * FROM chat_attachments WHERE expires_at>0 AND expires_at<? LIMIT 5', now),
    removeAttachment: id => run(env, 'DELETE FROM chat_attachments WHERE id=?', id),
    finalizeAttachments: ids => ids.length && run(env, `UPDATE chat_attachments SET expires_at=0 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids),
    reactions: ids => ids.length ? all(env, `SELECT * FROM chat_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids) : [],
    setReaction: (messageId, userId, emoji, active) => active
      ? run(env, 'INSERT OR IGNORE INTO chat_reactions (message_id,user_id,emoji) VALUES (?,?,?)', messageId, userId, emoji)
      : run(env, 'DELETE FROM chat_reactions WHERE message_id=? AND user_id=? AND emoji=?', messageId, userId, emoji),
  };
}
