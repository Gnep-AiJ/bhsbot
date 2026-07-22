CREATE TABLE IF NOT EXISTS channel_media (
  source_id TEXT PRIMARY KEY,
  image_key TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  attached_product_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attached_product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_media_expiry
  ON channel_media(status, expires_at);

ALTER TABLE sales ADD COLUMN voided_at TEXT;
ALTER TABLE sales ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE sales ADD COLUMN void_operator_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_sales_active_created
  ON sales(voided_at, created_at DESC);
