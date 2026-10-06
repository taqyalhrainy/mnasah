import { chatDefaults } from '../shared/chat.js';

export function mongoChatStore(db) {
  const members = db.collection('chat_members');
  const messages = db.collection('direct_messages');
  return {
    async relationships(user) {
      const match = user.role === 'students' ? { student_id: user.id } : {};
      return db.collection('bookings').aggregate([
        { $match: match }, { $lookup: { from: 'slots', localField: 'slot_id', foreignField: 'id', as: 'slot' } },
        { $unwind: '$slot' }, ...(user.role === 'teachers' ? [{ $match: { 'slot.teacher_id': user.id } }] : []),
        { $group: { _id: { teacher_id: '$slot.teacher_id', student_id: '$student_id' } } },
        { $replaceRoot: { newRoot: '$_id' } },
      ]).toArray();
    },
    async ensureConversation(thread) {
      await db.collection('conversations').updateOne({ id: thread.id }, { $setOnInsert: thread }, { upsert: true });
      await Promise.all([thread.teacher_id, thread.student_id].map(userId => members.updateOne({ thread_id: thread.id, user_id: userId }, { $setOnInsert: { thread_id: thread.id, user_id: userId, hidden: 0, blocked: 0, muted: 0, deleted_at: 0, read_at: 0, typing_until: 0 } }, { upsert: true })));
    },
    conversations: userId => db.collection('conversations').find({ $or: [{ teacher_id: userId }, { student_id: userId }] }, { projection: { _id: 0 } }).toArray(),
    conversation: id => db.collection('conversations').findOne({ id }, { projection: { _id: 0 } }),
    member: (threadId, userId) => members.findOne({ thread_id: threadId, user_id: userId }, { projection: { _id: 0 } }),
    updateMember: (threadId, userId, changes) => members.updateOne({ thread_id: threadId, user_id: userId }, { $set: changes }),
    markRead: (threadId, userId, time) => members.updateOne({ thread_id: threadId, user_id: userId }, { $max: { read_at: time } }),
    async settings(userId) { return { ...chatDefaults, ...await db.collection('chat_settings').findOne({ user_id: userId }, { projection: { _id: 0, user_id: 0 } }) }; },
    saveSettings: (userId, changes) => db.collection('chat_settings').updateOne({ user_id: userId }, { $set: changes }, { upsert: true }),
    user: id => db.collection('users').findOne({ id }, { projection: { _id: 0, id: 1, name: 1, role: 1, status: 1 } }),
    async summary(threadId, userId, readAt, deletedAt) {
      const [last, unread] = await Promise.all([
        messages.find({ thread_id: threadId, created: { $gt: deletedAt } }, { projection: { _id: 0 } }).sort({ created: -1, id: -1 }).limit(1).toArray(),
        messages.countDocuments({ thread_id: threadId, author_id: { $ne: userId }, created: { $gt: readAt } }),
      ]);
      return { last: last[0], unread };
    },
    messages: (threadId, deletedAt, before, beforeId) => messages.find({ thread_id: threadId, created: { $gt: deletedAt }, ...(before ? { $or: [{ created: { $lt: before, $gt: deletedAt } }, { created: before, id: { $lt: beforeId } }] } : {}) }, { projection: { _id: 0 } }).sort({ created: -1, id: -1 }).limit(51).toArray(),
    message: id => messages.findOne({ id }, { projection: { _id: 0 } }),
    insertMessage: message => messages.insertOne(message),
    attachment: id => db.collection('chat_attachments').findOne({ id }, { projection: { _id: 0 } }),
    saveAttachment: file => db.collection('chat_attachments').insertOne(file),
    updateAttachment: (id, changes) => db.collection('chat_attachments').updateOne({ id }, { $set: changes }),
    removeAttachment: id => db.collection('chat_attachments').deleteOne({ id }),
    recentAttachments: (userId, since) => db.collection('chat_attachments').find({ author_id: userId, created: { $gt: since } }).limit(201).toArray(),
    expiredAttachments: now => db.collection('chat_attachments').find({ expires_at: { $gt: 0, $lt: now } }).limit(50).toArray(),
    finalizeAttachments: ids => Promise.all(ids.map(id => db.collection('chat_attachments').updateOne({ id }, { $set: { expires_at: 0 } }))),
    reactions: ids => db.collection('chat_reactions').find({ message_id: { $in: ids } }, { projection: { _id: 0 } }).toArray(),
    setReaction: (messageId, userId, emoji, active) => active
      ? db.collection('chat_reactions').updateOne({ message_id: messageId, user_id: userId, emoji }, { $setOnInsert: { message_id: messageId, user_id: userId, emoji } }, { upsert: true })
      : db.collection('chat_reactions').deleteOne({ message_id: messageId, user_id: userId, emoji }),
  };
}
