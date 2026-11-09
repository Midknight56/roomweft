-- A replacement quote holds one piece for a line that was refunded on an earlier receipt.
-- Only one live replacement may exist per returned line. A stale, superseded or declined one leaves the index,
-- so the visitor can freeze a fresh one. Old rows keep NULL and stay valid.
ALTER TABLE quotes ADD COLUMN replaces_quote_id TEXT;
ALTER TABLE quotes ADD COLUMN replaces_line_id TEXT;
CREATE UNIQUE INDEX quotes_replaces_live ON quotes(replaces_quote_id, replaces_line_id)
  WHERE replaces_quote_id IS NOT NULL AND state NOT IN ('stale', 'superseded', 'declined');
