ALTER TABLE items ADD COLUMN priority TEXT CHECK (priority IN ('must','interested','someday'));
ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','bought','dropped','snoozed'));
ALTER TABLE items ADD COLUMN snoozed_until TEXT;
ALTER TABLE items ADD COLUMN last_alert_cents INTEGER;
ALTER TABLE items ADD COLUMN edition_of TEXT REFERENCES items(id);
ALTER TABLE wishlists ADD COLUMN redrop_pct INTEGER;

CREATE TABLE alerts_new (
  id TEXT PRIMARY KEY,
  wishlist_id TEXT NOT NULL, item_id TEXT NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pct','target','both','redrop')),
  baseline_cents INTEGER NOT NULL, price_cents INTEGER NOT NULL,
  title TEXT NOT NULL, product_url TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO alerts_new SELECT * FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
