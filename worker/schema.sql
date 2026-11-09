-- Khata D1 schema. Apply with:
--   npx wrangler d1 execute khata --config worker/wrangler.toml --remote --file worker/schema.sql
--
-- Money is stored as integer paise. Deletes are soft (deleted = 1) so an
-- out-of-date client cannot resurrect a row that was removed on another device.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  shop_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  phone_number TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  -- Tenancy config as JSON (amount, start_date, mode, end_date, skipped), or NULL.
  rent_json    TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  shop_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('GIVEN', 'GOT')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  note         TEXT NOT NULL DEFAULT '',
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  -- 'manual' or 'rent'; rent_cycle is the 'YYYY-MM' the charge covers.
  source       TEXT NOT NULL DEFAULT 'manual',
  rent_cycle   TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_customer
  ON transactions (shop_id, customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_customers_name
  ON customers (shop_id, name);

-- One row per (shop, transaction): the UNIQUE key is what makes SMS dispatch
-- at-most-once even when two syncs race or a batch is replayed.
CREATE TABLE IF NOT EXISTS sms_log (
  id             TEXT PRIMARY KEY,
  shop_id        TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  phone          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  provider       TEXT,
  provider_id    TEXT,
  body           TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  UNIQUE (shop_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_log_status ON sms_log (shop_id, status, created_at);
