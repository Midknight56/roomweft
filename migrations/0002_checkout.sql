CREATE TABLE quotes (
  id TEXT PRIMARY KEY, visitor TEXT NOT NULL, design_id TEXT NOT NULL, design_version INTEGER NOT NULL,
  lines TEXT NOT NULL, total_cents INTEGER NOT NULL CHECK (total_cents > 0), currency TEXT NOT NULL CHECK (currency = 'USD'),
  hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','ordering','approving','capturing','capture_unknown','paid','declined','cancelled','stale','superseded')),
  order_id TEXT, capture_id TEXT, captured_cents INTEGER, refunded_cents INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  approve_url TEXT, repriced TEXT
);
CREATE INDEX quotes_order_id ON quotes(order_id);
CREATE INDEX quotes_visitor ON quotes(visitor);
CREATE TABLE refunds (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), line_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  state TEXT NOT NULL CHECK (state IN ('requesting','pending','completed','failed','unknown')),
  paypal_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, resource_id TEXT, custom_id TEXT,
  received_at INTEGER NOT NULL, processed_at INTEGER
);
