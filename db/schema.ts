import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), name: text('name').notNull(),
  password: text('password').notNull(), role: text('role').notNull(), status: text('status').notNull(),
  subject: text('subject').notNull().default(''), bio: text('bio').notNull().default(''),
  created: integer('created').notNull(),
});
export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(), userId: text('user_id').notNull().references(() => users.id), expires: integer('expires').notNull(),
});
export const slots = sqliteTable('slots', {
  id: text('id').primaryKey(), teacherId: text('teacher_id').notNull().references(() => users.id),
  start: integer('start').notNull(), minutes: integer('minutes').notNull(), price: integer('price').notNull(),
  subject: text('subject').notNull(), status: text('status').notNull().default('open'),
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
export const audit = sqliteTable('audit', {
  id: text('id').primaryKey(), actor: text('actor').notNull(), action: text('action').notNull(), target: text('target').notNull(), created: integer('created').notNull(),
});
