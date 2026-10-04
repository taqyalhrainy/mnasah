CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id), student_id TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
  UNIQUE (teacher_id, student_id)
);
CREATE TABLE IF NOT EXISTS chat_members (
  thread_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id),
  hidden INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL DEFAULT 0, read_at INTEGER NOT NULL DEFAULT 0, typing_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_settings (user_id TEXT PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES conversations(id), author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '', media_url TEXT NOT NULL DEFAULT '', reply_to TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS direct_messages_thread_created ON direct_messages(thread_id, created, id);
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES direct_messages(id), user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
