CREATE TABLE IF NOT EXISTS integration_status (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_receipts (
  external_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
