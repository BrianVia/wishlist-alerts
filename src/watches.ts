import { canonicalizeWishlistUrl, collectWishlist, type CollectionFailure, type CollectionResult, type Snapshot, type SnapshotItem } from './collect';

type Frequency = 'daily' | 'hourly';
type AlertKind = 'pct' | 'target' | 'both' | null;
type ItemRow = SnapshotItem & { id: string; monitored: number; baselineCents: number | null; targetCents: number | null; pctThreshold: number; alertActive: number };
type WishlistRow = { id: string; user_id: string; source_url: string; name: string; monitored: number; frequency: Frequency; add_new_items: number; next_due_at: string | null; last_check_at: string | null; last_success_at: string | null; last_status: string | null; last_error: string | null; created_at: string; email?: string };

export function decideAlert(input: { priceCents: number | null; baselineCents: number | null; targetCents: number | null; pctThreshold: number; alertActive: boolean }): { qualifies: boolean; kind: AlertKind; nextAlertActive: boolean } {
  const { priceCents: price, baselineCents: baseline, targetCents: target, pctThreshold, alertActive } = input;
  if (price === null || baseline === null || baseline <= 0) return { qualifies: false, kind: null, nextAlertActive: alertActive };
  const pct = price * 100 < baseline * (100 - pctThreshold);
  const targetHit = target !== null && price <= target;
  const qualifies = pct || targetHit;
  return { qualifies, kind: pct && targetHit ? 'both' : pct ? 'pct' : targetHit ? 'target' : null, nextAlertActive: qualifies };
}

const nowIso = () => new Date().toISOString();
const nextDue = (frequency: Frequency, now = Date.now()) => new Date(now + (frequency === 'hourly' ? 3_600_000 : 86_400_000)).toISOString();

function storedItem(row: Record<string, unknown>): ItemRow {
  return {
    id: row.id as string, entryId: row.entry_id as string, asin: row.asin as string | null,
    productUrl: row.product_url as string, title: row.title as string, byline: row.byline as string | null,
    imageUrl: row.image_url as string | null, priceCents: null, currency: 'USD', availability: 'no_price',
    monitored: row.monitored as number, baselineCents: row.baseline_cents as number | null,
    targetCents: row.target_cents as number | null, pctThreshold: row.pct_threshold as number,
    alertActive: row.alert_active as number,
  };
}

export async function importWishlist(
  env: Env, userId: string, input: { url: string; frequency: Frequency; addNewItems: boolean },
  collector: (url: string, env: Env) => Promise<CollectionResult> = collectWishlist,
): Promise<{ wishlist: unknown; items: unknown[] } | { error: CollectionFailure }> {
  const canonical = canonicalizeWishlistUrl(input.url);
  if (!canonical) return { error: { ok: false, reason: 'invalid_url', detail: 'Use a shared Amazon US wishlist URL', pages: 0, durationMs: 0, usedBrowser: false } };
  const snapshot = await collector(canonical, env);
  if (!snapshot.ok) return { error: snapshot };
  const candidateId = crypto.randomUUID(), now = nowIso();
  const current = (await env.DB.prepare(`INSERT INTO wishlists (id,user_id,source_url,name,frequency,add_new_items,created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id,source_url) DO UPDATE SET source_url=excluded.source_url RETURNING *`)
    .bind(candidateId, userId, canonical, snapshot.name, input.frequency, input.addNewItems ? 1 : 0, now).first<WishlistRow>())!;
  const id = current.id, runId = `${id}_import_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [];
  statements.push(env.DB.prepare("INSERT INTO runs (id,wishlist_id,trigger,status,started_at,finished_at,item_count,priced_count,duration_ms,used_browser) VALUES (?,?,?,'recorded',?,?,?,?,?,?)")
    .bind(runId, id, 'manual', now, now, snapshot.items.length, snapshot.items.filter(i => i.priceCents !== null).length, snapshot.durationMs, snapshot.usedBrowser ? 1 : 0));
  const known = new Map((await env.DB.prepare('SELECT * FROM items WHERE wishlist_id=?').bind(id).all()).results.map(r => [r.entry_id as string, storedItem(r)]));
  for (const item of snapshot.items) {
    let stored = known.get(item.entryId);
    if (!stored) {
      stored = { ...item, id: `${id}:${item.entryId}`, monitored: 1, baselineCents: item.priceCents, targetCents: null, pctThreshold: 20, alertActive: 0 };
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO items (id,wishlist_id,entry_id,asin,product_url,title,byline,image_url,baseline_cents,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(stored.id, id, item.entryId, item.asin, item.productUrl, item.title, item.byline, item.imageUrl, item.priceCents, now, now));
    }
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO observations (item_id,run_id,observed_at,price_cents,currency,availability) VALUES (?,?,?,?,?,?)')
      .bind(stored.id, runId, now, item.priceCents, item.currency, item.availability));
  }
  statements.push(env.DB.prepare("UPDATE wishlists SET name=?,last_check_at=?,last_success_at=?,last_status='ok',last_error=NULL,next_due_at=? WHERE id=?")
    .bind(snapshot.name, now, now, nextDue(current.frequency), id));
  await env.DB.batch(statements);
  return (await getWishlist(env, userId, id))!;
}

export async function listDeals(env: Env, userId: string) {
  return (await env.DB.prepare(`SELECT i.id, i.title, i.product_url, i.image_url, i.baseline_cents, i.target_cents, i.last_seen_at observed_at, w.name list_name, w.id wishlist_id,
    (SELECT o.price_cents FROM observations o WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) current_cents
    FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE w.user_id=? AND i.alert_active=1 AND i.monitored=1
    ORDER BY current_cents*1.0/i.baseline_cents ASC LIMIT 100`).bind(userId).all()).results;
}

export async function listWishlists(env: Env, userId: string) {
  const rows = (await env.DB.prepare(`SELECT w.*, COUNT(i.id) item_count FROM wishlists w LEFT JOIN items i ON i.wishlist_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.created_at`).bind(userId).all()).results;
  const now = Date.now();
  return rows.map(row => ({ ...row, stale: !row.last_success_at || now - Date.parse(row.last_success_at as string) > (row.frequency === 'hourly' ? 7_200_000 : 172_800_000) }));
}

export async function getWishlist(env: Env, userId: string, id: string): Promise<{ wishlist: unknown; items: unknown[] } | null> {
  const wishlist = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(id, userId).first<WishlistRow>();
  if (!wishlist) return null;
  const items = (await env.DB.prepare(`SELECT i.*,
    (SELECT o.price_cents FROM observations o WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) current_cents,
    (SELECT o.availability FROM observations o WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) availability,
    i.last_seen_at observed_at,
    (SELECT MIN(o.price_cents) FROM observations o WHERE o.item_id=i.id AND o.price_cents IS NOT NULL) lowest_cents
    FROM items i WHERE i.wishlist_id=? ORDER BY i.created_at`).bind(id).all()).results;
  const stale = !wishlist.last_success_at || Date.now() - Date.parse(wishlist.last_success_at) > (wishlist.frequency === 'hourly' ? 7_200_000 : 172_800_000);
  return { wishlist: { ...wishlist, stale }, items };
}

export async function updateWishlist(env: Env, userId: string, id: string, patch: { monitored?: boolean; frequency?: Frequency; addNewItems?: boolean; name?: string }) {
  const current = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(id, userId).first<WishlistRow>();
  if (!current) return null;
  const monitored = patch.monitored ?? !!current.monitored, frequency = patch.frequency ?? current.frequency;
  await env.DB.prepare('UPDATE wishlists SET monitored=?,frequency=?,add_new_items=?,name=?,next_due_at=? WHERE id=? AND user_id=?')
    .bind(monitored ? 1 : 0, frequency, patch.addNewItems === undefined ? current.add_new_items : patch.addNewItems ? 1 : 0,
      patch.name ?? current.name, !monitored ? null : patch.monitored === true ? nowIso() : current.next_due_at, id, userId).run();
  return getWishlist(env, userId, id);
}

export async function updateItem(env: Env, userId: string, itemId: string, patch: { monitored?: boolean; targetCents?: number | null; pctThreshold?: number }) {
  const item = await env.DB.prepare('SELECT i.* FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE i.id=? AND w.user_id=?').bind(itemId, userId).first<Record<string, unknown>>();
  if (!item) return null;
  await env.DB.prepare(`UPDATE items SET monitored=?, target_cents=?, pct_threshold=? WHERE id=? AND EXISTS (SELECT 1 FROM wishlists w WHERE w.id=items.wishlist_id AND w.user_id=?)`)
    .bind(patch.monitored === undefined ? item.monitored : patch.monitored ? 1 : 0, patch.targetCents === undefined ? item.target_cents : patch.targetCents,
      patch.pctThreshold ?? item.pct_threshold, itemId, userId).run();
  return env.DB.prepare('SELECT * FROM items WHERE id=?').bind(itemId).first();
}

export async function itemHistory(env: Env, userId: string, itemId: string, options: { limit?: number } = {}) {
  const owned = await env.DB.prepare('SELECT i.id FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE i.id=? AND w.user_id=?').bind(itemId, userId).first();
  if (!owned) return null;
  return (await env.DB.prepare('SELECT observed_at,price_cents,currency,availability FROM observations WHERE item_id=? ORDER BY observed_at DESC LIMIT ?').bind(itemId, options.limit ?? 200).all()).results;
}

export async function dueWishlists(env: Env, now: number) {
  return (await env.DB.prepare('SELECT id,source_url AS url FROM wishlists WHERE monitored=1 AND next_due_at<=? ORDER BY next_due_at LIMIT 50').bind(new Date(now).toISOString()).all<{ id: string; url: string }>()).results;
}

export async function startRun(env: Env, input: { wishlistId: string; runId: string; trigger: 'scheduled' | 'manual'; startedAt?: string }) {
  const result = await env.DB.prepare("INSERT OR IGNORE INTO runs (id,wishlist_id,trigger,status,started_at) SELECT ?,?,?, 'running',? WHERE EXISTS (SELECT 1 FROM wishlists WHERE id=?)")
    .bind(input.runId, input.wishlistId, input.trigger, input.startedAt ?? nowIso(), input.wishlistId).run();
  return result.meta.changes === 1;
}

export async function abandonRun(env: Env, runId: string) {
  await env.DB.prepare("DELETE FROM runs WHERE id=? AND status='running'").bind(runId).run();
}

export async function requestManualCheck(env: Env, userId: string, wishlistId: string, now: number): Promise<{ runId: string } | { error: 'rate_limited' | 'paused' | 'not_found' }> {
  const wishlist = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(wishlistId, userId).first<WishlistRow>();
  if (!wishlist) return { error: 'not_found' };
  if (!wishlist.monitored) return { error: 'paused' };
  const latest = await env.DB.prepare("SELECT MAX(started_at) started_at FROM runs WHERE wishlist_id=? AND trigger='manual'").bind(wishlistId).first<{ started_at: string | null }>();
  if (latest?.started_at && now - Date.parse(latest.started_at) < 300_000) return { error: 'rate_limited' };
  const runId = `${wishlistId}_manual_${Math.floor(now / 300_000)}`;
  if (!await startRun(env, { wishlistId, runId, trigger: 'manual', startedAt: new Date(now).toISOString() })) return { error: 'rate_limited' };
  return { runId };
}

// Verification: a real day never moves most of a list by one identical ratio. That signature means the
// collector saw converted currency or a wrong offer type, so refuse the whole run instead of alerting.
export function looksSystematic(pairs: Array<{ priceCents: number | null; baselineCents: number | null }>): string | null {
  const ratios = pairs.filter(p => p.priceCents !== null && p.baselineCents !== null && p.baselineCents > 0).map(p => Math.round((p.priceCents! / p.baselineCents!) * 100));
  if (ratios.length < 10) return null;
  const counts = new Map<number, number>();
  for (const r of ratios) counts.set(r, (counts.get(r) ?? 0) + 1);
  const [ratio, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return ratio !== 100 && n * 2 >= ratios.length ? `${n} of ${ratios.length} priced items moved to ${ratio}% of baseline at once` : null;
}

export async function recordCheck(env: Env, input: { runId: string; snapshot?: Snapshot; failure?: CollectionFailure }): Promise<{ alertsCreated: number }> {
  const row = await env.DB.prepare(`SELECT r.*,w.*,w.id wishlist_id,u.email FROM runs r JOIN wishlists w ON w.id=r.wishlist_id JOIN users u ON u.id=w.user_id WHERE r.id=?`).bind(input.runId).first<Record<string, unknown>>();
  if (!row || row.status !== 'running') return { alertsCreated: 0 };
  const now = nowIso(), frequency = row.frequency as Frequency;
  if (row.last_success_at && Date.parse(row.started_at as string) < Date.parse(row.last_success_at as string)) {
    await env.DB.prepare("UPDATE runs SET status='failed',finished_at=?,error='stale' WHERE id=? AND status='running'").bind(now, input.runId).run();
    return { alertsCreated: 0 };
  }
  if (input.failure) {
    await env.DB.batch([
      env.DB.prepare("UPDATE runs SET status='failed',finished_at=?,error=? WHERE id=? AND status='running'").bind(now, input.failure.reason, input.runId),
      env.DB.prepare('UPDATE wishlists SET last_check_at=?,last_status=?,last_error=?,next_due_at=? WHERE id=?').bind(now, input.failure.reason, input.failure.detail, nextDue(frequency), row.wishlist_id),
    ]);
    return { alertsCreated: 0 };
  }
  if (!input.snapshot) throw new Error('recordCheck requires a snapshot or failure');
  const storedRows = (await env.DB.prepare('SELECT * FROM items WHERE wishlist_id=?').bind(row.wishlist_id).all()).results;
  const stored = new Map(storedRows.map(r => [r.entry_id as string, storedItem(r)]));
  const lastPriced = (await env.DB.prepare("SELECT priced_count FROM runs WHERE wishlist_id=? AND status='recorded' AND id<>? ORDER BY started_at DESC LIMIT 1").bind(row.wishlist_id, input.runId).first<{ priced_count: number | null }>())?.priced_count ?? null;
  const priced = input.snapshot.items.filter(i => i.priceCents !== null).length;
  const suspect = looksSystematic(input.snapshot.items.map(i => ({ priceCents: i.priceCents, baselineCents: stored.get(i.entryId)?.baselineCents ?? null })))
    ?? (lastPriced !== null && lastPriced >= 20 && priced * 100 < lastPriced * 60 ? `only ${priced} priced items where the last check had ${lastPriced}` : null);
  if (suspect) return recordCheck(env, { runId: input.runId, failure: { ok: false, reason: 'suspect', detail: suspect, pages: input.snapshot.pages, durationMs: input.snapshot.durationMs, usedBrowser: input.snapshot.usedBrowser } });
  // ponytail: history is write-on-change; last_seen_at carries freshness. Revisit if a chart needs per-check samples.
  const latest = new Map((await env.DB.prepare(`SELECT o.item_id, o.price_cents, o.availability FROM observations o JOIN items i ON i.id=o.item_id
    WHERE i.wishlist_id=? AND o.observed_at=(SELECT MAX(observed_at) FROM observations WHERE item_id=o.item_id)`).bind(row.wishlist_id).all<{ item_id: string; price_cents: number | null; availability: string }>()).results.map(r => [r.item_id, r]));
  const staged: D1PreparedStatement[] = [], state: D1PreparedStatement[] = [], alertRows: Record<string, unknown>[] = [], final: D1PreparedStatement[] = [];
  const stateRows: Record<string, unknown>[] = [];
  let alertsCreated = 0;
  for (const item of input.snapshot.items) {
    let prior = stored.get(item.entryId), isNew = false;
    if (!prior) {
      if (!row.add_new_items) continue;
      isNew = true;
      prior = { ...item, id: `${String(row.wishlist_id)}:${item.entryId}`, monitored: 1, baselineCents: item.priceCents, targetCents: null, pctThreshold: 20, alertActive: 0 };
      staged.push(env.DB.prepare('INSERT OR IGNORE INTO items (id,wishlist_id,entry_id,asin,product_url,title,byline,image_url,baseline_cents,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(prior.id, row.wishlist_id, item.entryId, item.asin, item.productUrl, item.title, item.byline, item.imageUrl, item.priceCents, now, now));
    }
    const last = latest.get(prior.id);
    if (!last || last.price_cents !== item.priceCents || last.availability !== item.availability)
      staged.push(env.DB.prepare('INSERT OR IGNORE INTO observations (item_id,run_id,observed_at,price_cents,currency,availability) VALUES (?,?,?,?,?,?)')
        .bind(prior.id, input.runId, now, item.priceCents, item.currency, item.availability));
    const baseline = prior.baselineCents ?? item.priceCents;
    const decision = prior.monitored && row.monitored ? decideAlert({ priceCents: isNew || prior.baselineCents === null ? null : item.priceCents, baselineCents: baseline, targetCents: prior.targetCents, pctThreshold: prior.pctThreshold, alertActive: !!prior.alertActive })
      : { qualifies: false, kind: null, nextAlertActive: !!prior.alertActive };
    state.push(env.DB.prepare('UPDATE items SET asin=?,product_url=?,title=?,byline=?,image_url=?,last_seen_at=?,baseline_cents=COALESCE(baseline_cents,?),alert_active=? WHERE id=?')
      .bind(item.asin, item.productUrl, item.title, item.byline, item.imageUrl, now, item.priceCents, decision.nextAlertActive ? 1 : 0, prior.id));
    stateRows.push({ id: prior.id, asin: item.asin, productUrl: item.productUrl, title: item.title, byline: item.byline, imageUrl: item.imageUrl, lastSeenAt: now, priceCents: item.priceCents, alertActive: decision.nextAlertActive ? 1 : 0 });
    if (decision.qualifies && !prior.alertActive && decision.kind && item.priceCents !== null && baseline !== null) {
      alertsCreated++;
      alertRows.push({ id: `${input.runId}:${prior.id}`, wishlistId: row.wishlist_id, itemId: prior.id, runId: input.runId, kind: decision.kind, baselineCents: baseline, priceCents: item.priceCents, title: item.title, productUrl: item.productUrl, createdAt: now });
    }
  }
  const chunked = staged.length + state.length + alertRows.length > 95;
  if (chunked) {
    // ponytail: idempotent staging handles D1's batch ceiling; use a dedicated staging table only if snapshots outgrow the 1 MiB Workflow payload.
    for (let i = 0; i < staged.length; i += 95) await env.DB.batch(staged.slice(i, i + 95));
    final.push(env.DB.prepare(`WITH changes AS (
      SELECT json_extract(value,'$.id') id,json_extract(value,'$.asin') asin,json_extract(value,'$.productUrl') product_url,
        json_extract(value,'$.title') title,json_extract(value,'$.byline') byline,json_extract(value,'$.imageUrl') image_url,
        json_extract(value,'$.lastSeenAt') last_seen_at,json_extract(value,'$.priceCents') price_cents,json_extract(value,'$.alertActive') alert_active FROM json_each(?)
      ) UPDATE items SET asin=(SELECT asin FROM changes WHERE changes.id=items.id),product_url=(SELECT product_url FROM changes WHERE changes.id=items.id),
        title=(SELECT title FROM changes WHERE changes.id=items.id),byline=(SELECT byline FROM changes WHERE changes.id=items.id),image_url=(SELECT image_url FROM changes WHERE changes.id=items.id),
        last_seen_at=(SELECT last_seen_at FROM changes WHERE changes.id=items.id),baseline_cents=COALESCE(baseline_cents,(SELECT price_cents FROM changes WHERE changes.id=items.id)),
        alert_active=(SELECT alert_active FROM changes WHERE changes.id=items.id) WHERE id IN (SELECT id FROM changes)`).bind(JSON.stringify(stateRows)));
    if (alertRows.length) final.push(env.DB.prepare(`INSERT OR IGNORE INTO alerts (id,wishlist_id,item_id,run_id,kind,baseline_cents,price_cents,title,product_url,created_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.wishlistId'),json_extract(value,'$.itemId'),json_extract(value,'$.runId'),json_extract(value,'$.kind'),
        json_extract(value,'$.baselineCents'),json_extract(value,'$.priceCents'),json_extract(value,'$.title'),json_extract(value,'$.productUrl'),json_extract(value,'$.createdAt') FROM json_each(?)`).bind(JSON.stringify(alertRows)));
  } else {
    final.push(...staged, ...state);
    for (const alert of alertRows) final.push(env.DB.prepare('INSERT OR IGNORE INTO alerts (id,wishlist_id,item_id,run_id,kind,baseline_cents,price_cents,title,product_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(alert.id, alert.wishlistId, alert.itemId, alert.runId, alert.kind, alert.baselineCents, alert.priceCents, alert.title, alert.productUrl, alert.createdAt));
  }
  if (alertsCreated) final.push(env.DB.prepare("INSERT OR IGNORE INTO deliveries (id,wishlist_id,run_id,recipient,status,created_at) VALUES (?,?,?,?, 'pending',?)")
    .bind(input.runId, row.wishlist_id, input.runId, row.email, now));
  final.push(
    env.DB.prepare("UPDATE runs SET status='recorded',finished_at=?,item_count=?,priced_count=?,duration_ms=?,used_browser=? WHERE id=? AND status='running'")
      .bind(now, input.snapshot.items.length, input.snapshot.items.filter(i => i.priceCents !== null).length, input.snapshot.durationMs, input.snapshot.usedBrowser ? 1 : 0, input.runId),
    env.DB.prepare("UPDATE wishlists SET name=?,last_check_at=?,last_success_at=?,last_status='ok',last_error=NULL,next_due_at=? WHERE id=?")
      .bind(input.snapshot.name, now, now, nextDue(frequency), row.wishlist_id),
  );
  await env.DB.batch(final);
  return { alertsCreated };
}

export async function alertsForRun(env: Env, runId: string) {
  return (await env.DB.prepare('SELECT * FROM alerts WHERE run_id=? ORDER BY created_at').bind(runId).all()).results;
}

export async function deliveriesForWishlist(env: Env, userId: string, wishlistId: string) {
  const owned = await env.DB.prepare('SELECT id FROM wishlists WHERE id=? AND user_id=?').bind(wishlistId, userId).first();
  if (!owned) return null;
  return (await env.DB.prepare('SELECT * FROM deliveries WHERE wishlist_id=? ORDER BY created_at DESC LIMIT 5').bind(wishlistId).all()).results;
}
