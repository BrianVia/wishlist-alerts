CREATE TABLE users (id TEXT PRIMARY KEY, auth_subject TEXT UNIQUE NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE wishlists (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  source_url TEXT NOT NULL, name TEXT NOT NULL,
  monitored INTEGER NOT NULL DEFAULT 1, frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','hourly')),
  add_new_items INTEGER NOT NULL DEFAULT 1,
  next_due_at TEXT, last_check_at TEXT, last_success_at TEXT, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, UNIQUE(user_id, source_url));
CREATE INDEX wishlists_due ON wishlists(monitored, next_due_at);
CREATE TABLE items (
  id TEXT PRIMARY KEY, wishlist_id TEXT NOT NULL REFERENCES wishlists(id),
  entry_id TEXT NOT NULL, asin TEXT, product_url TEXT NOT NULL, title TEXT NOT NULL, byline TEXT, image_url TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  baseline_cents INTEGER, currency TEXT NOT NULL DEFAULT 'USD',
  target_cents INTEGER, pct_threshold INTEGER NOT NULL DEFAULT 20,
  alert_active INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT, created_at TEXT NOT NULL, UNIQUE(wishlist_id, entry_id));
CREATE TABLE runs (
  id TEXT PRIMARY KEY, wishlist_id TEXT NOT NULL REFERENCES wishlists(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','manual')),
  status TEXT NOT NULL CHECK (status IN ('running','collected','recorded','failed')),
  started_at TEXT NOT NULL, finished_at TEXT, item_count INTEGER, priced_count INTEGER, error TEXT, duration_ms INTEGER, used_browser INTEGER);
CREATE TABLE observations (
  item_id TEXT NOT NULL REFERENCES items(id), run_id TEXT NOT NULL REFERENCES runs(id),
  observed_at TEXT NOT NULL, price_cents INTEGER, currency TEXT NOT NULL DEFAULT 'USD', availability TEXT NOT NULL,
  PRIMARY KEY (item_id, run_id));
CREATE INDEX observations_item_time ON observations(item_id, observed_at);
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  wishlist_id TEXT NOT NULL, item_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pct','target','both')),
  baseline_cents INTEGER NOT NULL, price_cents INTEGER NOT NULL, title TEXT NOT NULL, product_url TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  wishlist_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, provider_message_id TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
CREATE INDEX deliveries_pending ON deliveries(status);
