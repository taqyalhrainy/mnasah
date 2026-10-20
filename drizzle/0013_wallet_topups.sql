CREATE TABLE wallet_accounts (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);

CREATE TABLE wallet_topups (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transfer_reference TEXT NOT NULL DEFAULT '',
  proof_name TEXT NOT NULL,
  proof_size INTEGER NOT NULL,
  proof_type TEXT NOT NULL,
  proof_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT NOT NULL DEFAULT '',
  rejection_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX wallet_topups_status_created ON wallet_topups(status, created);
CREATE INDEX wallet_topups_user_created ON wallet_topups(user_id, created);

CREATE TABLE wallet_topup_chunks (
  topup_id TEXT NOT NULL REFERENCES wallet_topups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (topup_id, position)
);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE UNIQUE INDEX wallet_transactions_reference_unique ON wallet_transactions(reference) WHERE reference <> '';
