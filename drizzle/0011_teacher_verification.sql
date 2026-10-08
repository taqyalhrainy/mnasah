ALTER TABLE users ADD COLUMN verification TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE verification_files (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX verification_files_user_kind ON verification_files(user_id, kind);
--> statement-breakpoint
CREATE TABLE verification_file_chunks (
  file_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, position),
  FOREIGN KEY (file_id) REFERENCES verification_files(id) ON DELETE CASCADE
);
