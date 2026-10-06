ALTER TABLE direct_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
CREATE TABLE chat_attachments (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES conversations(id),
  author_id TEXT NOT NULL REFERENCES users(id), message_id TEXT NOT NULL,
  name TEXT NOT NULL, size INTEGER NOT NULL, preview_type TEXT NOT NULL DEFAULT '',
  ready INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX chat_attachments_author_created ON chat_attachments(author_id,created);
CREATE INDEX chat_attachments_expires ON chat_attachments(expires_at);
-- Chunked bytes keep each D1 row below its 2 MB limit, without another service.
CREATE TABLE chat_file_chunks (
  attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (attachment_id,position)
);
