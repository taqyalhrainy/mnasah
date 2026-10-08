import { sqliteTable, text, integer, blob, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), name: text('name').notNull(),
  password: text('password').notNull(), role: text('role').notNull(), status: text('status').notNull(),
  mustChangePassword: integer('must_change_password').notNull().default(0),
  temporaryPasswordExpires: integer('temporary_password_expires'),
  subject: text('subject').notNull().default(''), bio: text('bio').notNull().default(''),
  academicLevel: text('academic_level').notNull().default(''), phone: text('phone').notNull().default(''),
  customPackages: text('custom_packages').notNull().default('[]'),
  verification: text('verification').notNull().default('{}'),
  authProvider: text('auth_provider').notNull().default('password'),
  emailVerified: integer('email_verified').notNull().default(0),
  created: integer('created').notNull(),
});
export const verificationFiles = sqliteTable('verification_files', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), name: text('name').notNull(), size: integer('size').notNull(),
  contentType: text('content_type').notNull(), created: integer('created').notNull(),
}, t => [index('verification_files_user_kind').on(t.userId, t.kind)]);
export const verificationFileChunks = sqliteTable('verification_file_chunks', {
  fileId: text('file_id').notNull().references(() => verificationFiles.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(), data: blob('data', { mode: 'buffer' }).notNull(),
}, t => [primaryKey({ columns: [t.fileId, t.position] })]);
export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(), userId: text('user_id').notNull().references(() => users.id), expires: integer('expires').notNull(),
  developmentKey: text('development_key'),
});
export const slots = sqliteTable('slots', {
  id: text('id').primaryKey(), teacherId: text('teacher_id').notNull().references(() => users.id),
  start: integer('start').notNull(), minutes: integer('minutes').notNull(), price: integer('price').notNull(),
  subject: text('subject').notNull(), status: text('status').notNull().default('open'), availableUntil: integer('available_until').notNull().default(0),
}, t => [uniqueIndex('teacher_start').on(t.teacherId, t.start)]);
export const bookings = sqliteTable('bookings', {
  id: text('id').primaryKey(), slotId: text('slot_id').notNull().references(() => slots.id),
  studentId: text('student_id').notNull().references(() => users.id), status: text('status').notNull(),
  room: text('room').notNull(), paid: integer('paid').notNull().default(0), paymentRef: text('payment_ref').notNull().default(''),
  notes: text('notes').notNull().default(''), resource: text('resource').notNull().default(''), created: integer('created').notNull(),
});
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), bookingId: text('booking_id').notNull().references(() => bookings.id),
  authorId: text('author_id').notNull().references(() => users.id), body: text('body').notNull(), created: integer('created').notNull(),
});
export const limits = sqliteTable('limits', { key: text('key').primaryKey(), count: integer('count').notNull(), expires: integer('expires').notNull() });
export const catalog = sqliteTable('catalog', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), parentId: text('parent_id').notNull().default(''),
  name: text('name').notNull(), description: text('description').notNull().default(''), icon: text('icon').notNull().default(''),
  position: integer('position').notNull().default(0), levels: text('levels').notNull().default('[]'), subjects: text('subjects').notNull().default('[]'), created: integer('created').notNull(),
});
export const audit = sqliteTable('audit', {
  id: text('id').primaryKey(), actor: text('actor').notNull(), action: text('action').notNull(), target: text('target').notNull(), created: integer('created').notNull(),
});
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(), teacherId: text('teacher_id').notNull().references(() => users.id),
  studentId: text('student_id').notNull().references(() => users.id), created: integer('created').notNull(),
}, t => [uniqueIndex('conversation_pair').on(t.teacherId, t.studentId)]);
export const chatMembers = sqliteTable('chat_members', {
  threadId: text('thread_id').notNull().references(() => conversations.id), userId: text('user_id').notNull().references(() => users.id),
  hidden: integer('hidden').notNull().default(0), blocked: integer('blocked').notNull().default(0), muted: integer('muted').notNull().default(0),
  deletedAt: integer('deleted_at').notNull().default(0), readAt: integer('read_at').notNull().default(0), typingUntil: integer('typing_until').notNull().default(0),
}, t => [primaryKey({ columns: [t.threadId, t.userId] })]);
export const chatSettings = sqliteTable('chat_settings', { userId: text('user_id').primaryKey().references(() => users.id), value: text('value').notNull().default('{}') });
export const directMessages = sqliteTable('direct_messages', {
  id: text('id').primaryKey(), threadId: text('thread_id').notNull().references(() => conversations.id), authorId: text('author_id').notNull().references(() => users.id),
  body: text('body').notNull().default(''), mediaUrl: text('media_url').notNull().default(''), attachments: text('attachments').notNull().default('[]'), replyTo: text('reply_to').notNull().default(''), created: integer('created').notNull(),
}, t => [index('direct_messages_thread_created').on(t.threadId, t.created, t.id)]);
export const chatReactions = sqliteTable('chat_reactions', {
  messageId: text('message_id').notNull().references(() => directMessages.id), userId: text('user_id').notNull().references(() => users.id), emoji: text('emoji').notNull(),
}, t => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })]);
export const chatAttachments = sqliteTable('chat_attachments', {
  id: text('id').primaryKey(), threadId: text('thread_id').notNull().references(() => conversations.id),
  authorId: text('author_id').notNull().references(() => users.id), messageId: text('message_id').notNull(),
  name: text('name').notNull(), size: integer('size').notNull(), previewType: text('preview_type').notNull().default(''),
  ready: integer('ready').notNull().default(0), created: integer('created').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => [index('chat_attachments_author_created').on(t.authorId, t.created), index('chat_attachments_expires').on(t.expiresAt)]);
export const chatFileChunks = sqliteTable('chat_file_chunks', {
  attachmentId: text('attachment_id').notNull().references(() => chatAttachments.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(), data: blob('data', { mode: 'buffer' }).notNull(),
}, t => [primaryKey({ columns: [t.attachmentId, t.position] })]);
