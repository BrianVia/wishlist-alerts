import { canonicalizeWishlistUrl, collectWishlist, type CollectionFailure, type CollectionResult, type Snapshot, type SnapshotItem } from './collect';

type Frequency = 'daily' | 'hourly';
type AlertKind = 'pct' | 'target' | 'both' | 'redrop' | null;
type Priority = 'must' | 'interested' | 'someday' | null;
type ItemStatus = 'active' | 'bought' | 'dropped' | 'snoozed';
type ItemRow = SnapshotItem & { id: string; monitored: number; baselineCents: number | null; targetCents: number | null; pctThreshold: number; alertActive: number; lastAlertCents: number | null; priority: Priority; status: ItemStatus; editionOf: string | null };
type WishlistRow = { id: string; user_id: string; source_url: string; name: string; monitored: number; frequency: Frequency; add_new_items: number; redrop_pct: number | null; next_due_at: string | null; last_check_at: string | null; last_success_at: string | null; last_status: string | null; last_error: string | null; created_at: string; email?: string };

export function decideAlert(input: { priceCents: number | null; baselineCents: number | null; targetCents: number | null; pctThreshold: number; alertActive: boolean; lastAlertCents?: number | null; redropPct?: number | null }): { qualifies: boolean; kind: AlertKind; nextAlertActive: boolean } {
  const { priceCents: price, baselineCents: baseline, targetCents: target, pctThreshold, alertActive, lastAlertCents = null, redropPct = null } = input;
  if (price === null || baseline === null || baseline <= 0) return { qualifies: false, kind: null, nextAlertActive: alertActive };
  const pct = price * 100 < baseline * (100 - pctThreshold);
  const targetHit = target !== null && price <= target;
  const qualifies = pct || targetHit;
  if (qualifies && alertActive && redropPct !== null && lastAlertCents !== null && price * 100 < lastAlertCents * (100 - redropPct)) return { qualifies: true, kind: 'redrop', nextAlertActive: true };
  return { qualifies, kind: pct && targetHit ? 'both' : pct ? 'pct' : targetHit ? 'target' : null, nextAlertActive: qualifies };
}

export function priceContext(observations: { observed_at: string; price_cents: number | null }[], lastSeenAt: string) {
  const sorted = [...observations].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const spans = sorted.flatMap((observation, index) => {
    if (observation.price_cents === null) return [];
    const end = index + 1 < sorted.length ? Date.parse(sorted[index + 1].observed_at) : Date.parse(lastSeenAt);
    return [{ price: observation.price_cents, weight: Math.max(0, end - Date.parse(observation.observed_at)) }];
  });
  const total = spans.reduce((sum, span) => sum + span.weight, 0);
  const priced = sorted.filter(row => row.price_cents !== null);
  let typicalCents: number | null = priced[0]?.price_cents ?? null;
  if (total > 0) {
    let elapsed = 0;
    for (const span of spans.sort((a, b) => a.price - b.price)) {
      elapsed += span.weight;
      if (elapsed * 2 >= total) { typicalCents = span.price; break; }
    }
  }
  const daysObserved = total / 86_400_000;
  return { typicalCents, lowestCents: priced.length ? Math.min(...priced.map(row => row.price_cents!)) : null, daysObserved, coverage: daysObserved < 14 || priced.length < 2 ? 'thin' as const : 'ok' as const };
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
    alertActive: row.alert_active as number, lastAlertCents: row.last_alert_cents as number | null,
    priority: row.priority as Priority, status: row.status as ItemStatus, editionOf: row.edition_of as string | null,
  };
}

async function withPriceContext(env: Env, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows;
  const observations = (await env.DB.prepare(`SELECT o.item_id,o.observed_at,o.price_cents FROM observations o
    JOIN runs r ON r.id=o.run_id AND r.status='recorded' WHERE o.item_id IN (SELECT value FROM json_each(?)) ORDER BY o.observed_at`)
    .bind(JSON.stringify(rows.map(row => row.id))).all<{ item_id: string; observed_at: string; price_cents: number | null }>()).results;
  const grouped = new Map<string, typeof observations>();
  for (const observation of observations) grouped.set(observation.item_id, [...(grouped.get(observation.item_id) ?? []), observation]);
  return rows.map(row => {
    const context = priceContext(grouped.get(row.id as string) ?? [], row.observed_at as string);
    return { ...row, typical_cents: context.typicalCents, lowest_cents: context.lowestCents, days_observed: context.daysObserved, coverage: context.coverage };
  });
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
      stored = { ...item, id: `${id}:${item.entryId}`, monitored: 1, baselineCents: item.priceCents, targetCents: null, pctThreshold: 20, alertActive: 0, lastAlertCents: null, priority: null, status: 'active', editionOf: null };
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
  const rows = (await env.DB.prepare(`SELECT i.*, i.last_seen_at observed_at, w.name list_name, w.id wishlist_id,
    (SELECT o.price_cents FROM observations o JOIN runs r ON r.id=o.run_id AND r.status='recorded' WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) current_cents
    FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE w.user_id=? AND i.monitored=1 AND i.status='active'
      AND EXISTS (SELECT 1 FROM items a WHERE COALESCE(a.edition_of,a.id)=COALESCE(i.edition_of,i.id) AND a.alert_active=1 AND a.monitored=1 AND a.status='active')
    ORDER BY current_cents*1.0/i.baseline_cents ASC`).bind(userId).all()).results;
  const enriched = await withPriceContext(env, rows);
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of enriched) {
    const key = (row.edition_of as string | null) ?? row.id as string;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const deals: Record<string, unknown>[] = [...groups.values()].flatMap(group => {
    const priced = group.filter(item => item.current_cents !== null).sort((a, b) => (a.current_cents as number) - (b.current_cents as number));
    return priced.length ? [{ ...priced[0], edition_count: group.length }] : [];
  });
  return deals.sort((a, b) => (a.current_cents as number) / (a.baseline_cents as number) - (b.current_cents as number) / (b.baseline_cents as number)).slice(0, 100);
}

export async function listWishlists(env: Env, userId: string) {
  const rows = (await env.DB.prepare(`SELECT w.*, COUNT(i.id) item_count,
    (SELECT d.status FROM deliveries d WHERE d.wishlist_id=w.id ORDER BY d.created_at DESC LIMIT 1) delivery_status,
    (SELECT d.sent_at FROM deliveries d WHERE d.wishlist_id=w.id ORDER BY d.created_at DESC LIMIT 1) delivery_sent_at,
    (SELECT d.last_error FROM deliveries d WHERE d.wishlist_id=w.id ORDER BY d.created_at DESC LIMIT 1) delivery_error
    FROM wishlists w LEFT JOIN items i ON i.wishlist_id=w.id WHERE w.user_id=? GROUP BY w.id ORDER BY w.created_at`).bind(userId).all()).results;
  const now = Date.now();
  return rows.map(row => ({ ...row, stale: !row.last_success_at || now - Date.parse(row.last_success_at as string) > (row.frequency === 'hourly' ? 7_200_000 : 172_800_000) }));
}

export async function getWishlist(env: Env, userId: string, id: string): Promise<{ wishlist: unknown; items: unknown[] } | null> {
  const wishlist = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(id, userId).first<WishlistRow>();
  if (!wishlist) return null;
  const rows = (await env.DB.prepare(`SELECT i.*,
    (SELECT o.price_cents FROM observations o JOIN runs r ON r.id=o.run_id AND r.status='recorded' WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) current_cents,
    (SELECT o.availability FROM observations o JOIN runs r ON r.id=o.run_id AND r.status='recorded' WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) availability,
    i.last_seen_at observed_at,
    (SELECT p.title FROM items p WHERE p.id=i.edition_of) edition_title
    FROM items i WHERE i.wishlist_id=? ORDER BY i.created_at`).bind(id).all()).results;
  const items = await withPriceContext(env, rows);
  const stale = !wishlist.last_success_at || Date.now() - Date.parse(wishlist.last_success_at) > (wishlist.frequency === 'hourly' ? 7_200_000 : 172_800_000);
  return { wishlist: { ...wishlist, stale }, items };
}

export async function updateWishlist(env: Env, userId: string, id: string, patch: { monitored?: boolean; frequency?: Frequency; addNewItems?: boolean; name?: string; redropPct?: number | null }) {
  const current = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(id, userId).first<WishlistRow>();
  if (!current) return null;
  const monitored = patch.monitored ?? !!current.monitored, frequency = patch.frequency ?? current.frequency;
  await env.DB.prepare('UPDATE wishlists SET monitored=?,frequency=?,add_new_items=?,name=?,next_due_at=?,redrop_pct=? WHERE id=? AND user_id=?')
    .bind(monitored ? 1 : 0, frequency, patch.addNewItems === undefined ? current.add_new_items : patch.addNewItems ? 1 : 0,
      patch.name ?? current.name, !monitored ? null : patch.monitored === true ? nowIso() : current.next_due_at,
      patch.redropPct === undefined ? current.redrop_pct : patch.redropPct, id, userId).run();
  return getWishlist(env, userId, id);
}

export async function updateItem(env: Env, userId: string, itemId: string, patch: { monitored?: boolean; targetCents?: number | null; pctThreshold?: number; priority?: Priority; status?: ItemStatus; snoozedUntil?: string | null; editionOf?: string | null }): Promise<Record<string, unknown> | null | { error: 'edition_chain' }> {
  const item = await env.DB.prepare('SELECT i.* FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE i.id=? AND w.user_id=?').bind(itemId, userId).first<Record<string, unknown>>();
  if (!item) return null;
  if (patch.editionOf !== undefined && patch.editionOf !== null) {
    const primary = await env.DB.prepare(`SELECT i.id,i.edition_of FROM items i JOIN wishlists w ON w.id=i.wishlist_id
      WHERE i.id=? AND w.user_id=?`).bind(patch.editionOf, userId).first<{ id: string; edition_of: string | null }>();
    const hasEditions = await env.DB.prepare('SELECT 1 FROM items WHERE edition_of=? LIMIT 1').bind(itemId).first();
    if (!primary || primary.id === itemId || primary.edition_of || hasEditions) return { error: 'edition_chain' };
  }
  const status = patch.status ?? item.status as ItemStatus;
  await env.DB.prepare(`UPDATE items SET monitored=?, target_cents=?, pct_threshold=?,priority=?,status=?,snoozed_until=?,edition_of=? WHERE id=? AND EXISTS (SELECT 1 FROM wishlists w WHERE w.id=items.wishlist_id AND w.user_id=?)`)
    .bind(patch.monitored === undefined ? item.monitored : patch.monitored ? 1 : 0, patch.targetCents === undefined ? item.target_cents : patch.targetCents,
      patch.pctThreshold ?? item.pct_threshold, patch.priority === undefined ? item.priority : patch.priority, status,
      patch.status !== undefined && status !== 'snoozed' ? null : patch.snoozedUntil === undefined ? item.snoozed_until : patch.snoozedUntil,
      patch.editionOf === undefined ? item.edition_of : patch.editionOf,
      itemId, userId).run();
  if (status === 'bought' || status === 'dropped') await env.DB.prepare('UPDATE items SET monitored=0 WHERE id=?').bind(itemId).run();
  return env.DB.prepare('SELECT * FROM items WHERE id=?').bind(itemId).first();
}

export async function buyNext(env: Env, userId: string, budgetCents: number) {
  const rows = (await env.DB.prepare(`SELECT i.*,CASE WHEN p.id IS NULL THEN i.priority ELSE p.priority END effective_priority,
      CASE WHEN p.id IS NULL THEN i.target_cents ELSE p.target_cents END effective_target_cents,
      (SELECT o.price_cents FROM observations o JOIN runs r ON r.id=o.run_id AND r.status='recorded'
      WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) current_cents,i.last_seen_at observed_at
    FROM items i JOIN wishlists w ON w.id=i.wishlist_id LEFT JOIN items p ON p.id=i.edition_of
    WHERE w.user_id=? AND i.monitored=1 AND i.status='active'`).bind(userId).all()).results;
  const enriched = await withPriceContext(env, rows);
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of enriched) {
    if (row.current_cents === null || (row.current_cents as number) > budgetCents) continue;
    const key = (row.edition_of as string | null) ?? row.id as string;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const candidates = [...groups.values()].map(group => {
    const item = group.sort((a, b) => (a.current_cents as number) - (b.current_cents as number))[0];
    const price = item.current_cents as number, typical = item.typical_cents as number | null, days = Math.floor(item.days_observed as number);
    const ok = item.coverage === 'ok', below = ok && typical ? Math.max(0, Math.min(1, (typical - price) / typical)) : 0;
    const atLowest = ok && item.lowest_cents === price, targetHit = item.effective_target_cents !== null && price <= (item.effective_target_cents as number);
    const quality = 1 + below + (atLowest ? .5 : 0) + (targetHit ? .5 : 0) + (item.alert_active ? .25 : 0);
    const reasons: string[] = [];
    if (item.effective_priority === 'must') reasons.push('must-have'); else if (item.effective_priority === 'interested') reasons.push('interested');
    if (below > 0) reasons.push(`${Math.round(below * 100)}% below typical`);
    if (atLowest) reasons.push(`lowest observed in ${days} days`);
    if (targetHit) reasons.push('target hit');
    if (!ok) reasons.push(`only ${days} days of history`);
    const weight = item.effective_priority === 'must' ? 3 : item.effective_priority === 'interested' ? 2 : 1;
    return { item: { ...item, id: item.id as string, edition_count: group.length }, priceCents: price, score: weight * quality, reasons, exceptional: quality > 1 || item.effective_priority !== null };
  }).sort((a, b) => b.score - a.score || a.priceCents - b.priceCents);
  const picks: typeof candidates = []; let total = 0, skipped = 0;
  for (const candidate of candidates) {
    if (!candidate.exceptional || total + candidate.priceCents > budgetCents) { skipped++; continue; }
    picks.push(candidate); total += candidate.priceCents;
  }
  return { budgetCents, picks: picks.map(({ exceptional: _, ...pick }) => pick), leftoverCents: budgetCents - total, skipped, note: picks.length ? 'Items with no priority and nothing exceptional are skipped.' : 'Nothing exceptional fits the budget right now.' };
}

export async function itemHistory(env: Env, userId: string, itemId: string, options: { limit?: number } = {}) {
  const owned = await env.DB.prepare('SELECT i.id FROM items i JOIN wishlists w ON w.id=i.wishlist_id WHERE i.id=? AND w.user_id=?').bind(itemId, userId).first();
  if (!owned) return null;
  return (await env.DB.prepare("SELECT o.observed_at,o.price_cents,o.currency,o.availability FROM observations o JOIN runs r ON r.id=o.run_id AND r.status='recorded' WHERE o.item_id=? ORDER BY o.observed_at DESC LIMIT ?").bind(itemId, options.limit ?? 200).all()).results;
}

export async function dueWishlists(env: Env, now: number) {
  const at = new Date(now).toISOString(), lease = new Date(now - 900_000).toISOString();
  return (await env.DB.prepare("SELECT id,source_url AS url FROM wishlists w WHERE monitored=1 AND next_due_at<=? AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.wishlist_id=w.id AND r.status='running' AND r.started_at>?) ORDER BY next_due_at LIMIT 50").bind(at, lease).all<{ id: string; url: string }>()).results;
}

export async function startRun(env: Env, input: { wishlistId: string; runId: string; trigger: 'scheduled' | 'manual'; startedAt?: string }) {
  const startedAt = input.startedAt ?? nowIso();
  const result = await env.DB.prepare("INSERT OR IGNORE INTO runs (id,wishlist_id,trigger,status,started_at) SELECT ?,?,?,'running',? WHERE EXISTS (SELECT 1 FROM wishlists WHERE id=?) AND NOT EXISTS (SELECT 1 FROM runs WHERE wishlist_id=? AND status='running' AND started_at>?)")
    .bind(input.runId, input.wishlistId, input.trigger, startedAt, input.wishlistId, input.wishlistId, new Date(Date.now() - 900_000).toISOString()).run();
  return result.meta.changes === 1;
}

export async function abandonRun(env: Env, runId: string) {
  await env.DB.prepare("DELETE FROM runs WHERE id=? AND status='running'").bind(runId).run();
}

export async function requestManualCheck(env: Env, userId: string, wishlistId: string, now: number): Promise<{ runId: string } | { error: 'busy' | 'rate_limited' | 'paused' | 'not_found' }> {
  const wishlist = await env.DB.prepare('SELECT * FROM wishlists WHERE id=? AND user_id=?').bind(wishlistId, userId).first<WishlistRow>();
  if (!wishlist) return { error: 'not_found' };
  if (!wishlist.monitored) return { error: 'paused' };
  const active = await env.DB.prepare("SELECT 1 FROM runs WHERE wishlist_id=? AND status='running' AND started_at>? LIMIT 1").bind(wishlistId, new Date(now - 900_000).toISOString()).first();
  if (active) return { error: 'busy' };
  const latest = await env.DB.prepare("SELECT MAX(started_at) started_at FROM runs WHERE wishlist_id=? AND trigger='manual'").bind(wishlistId).first<{ started_at: string | null }>();
  if (latest?.started_at && now - Date.parse(latest.started_at) < 300_000) return { error: 'rate_limited' };
  const runId = `${wishlistId}_manual_${Math.floor(now / 300_000)}`;
  if (!await startRun(env, { wishlistId, runId, trigger: 'manual', startedAt: new Date(now).toISOString() })) return { error: 'busy' };
  return { runId };
}

// Verification: a real day never moves most of a list by one identical ratio. That signature means the
// collector saw converted currency or a wrong offer type, so refuse the whole run instead of alerting.
export function looksSystematic(pairs: Array<{ priceCents: number | null; previousCents: number | null }>): string | null {
  const ratios = pairs.filter(p => p.priceCents !== null && p.previousCents !== null && p.previousCents > 0).map(p => Math.round((p.priceCents! / p.previousCents!) * 100));
  if (ratios.length < 10) return null;
  const counts = new Map<number, number>();
  for (const r of ratios) counts.set(r, (counts.get(r) ?? 0) + 1);
  const [ratio, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return ratio !== 100 && n * 2 >= ratios.length ? `${n} of ${ratios.length} priced items moved to ${ratio}% of their previous price at once` : null;
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
  await env.DB.prepare("UPDATE items SET status='active',snoozed_until=NULL WHERE wishlist_id=? AND status='snoozed' AND snoozed_until<=?")
    .bind(row.wishlist_id, now.slice(0, 10)).run();
  const storedRows = (await env.DB.prepare(`SELECT i.*,p.target_cents primary_target_cents,p.pct_threshold primary_pct_threshold,p.priority primary_priority
    FROM items i LEFT JOIN items p ON p.id=i.edition_of WHERE i.wishlist_id=?`).bind(row.wishlist_id).all()).results;
  const stored = new Map(storedRows.map(r => [r.entry_id as string, storedItem(r)]));
  const storedRaw = new Map(storedRows.map(r => [r.id as string, r]));
  // Only recorded runs are published; staged observations from an interrupted large run stay invisible.
  const latest = new Map((await env.DB.prepare(`SELECT o.item_id,o.price_cents,o.availability FROM observations o
    JOIN runs r ON r.id=o.run_id AND r.status='recorded' JOIN items i ON i.id=o.item_id
    WHERE i.wishlist_id=? AND o.observed_at=(SELECT MAX(o2.observed_at) FROM observations o2 JOIN runs r2 ON r2.id=o2.run_id AND r2.status='recorded' WHERE o2.item_id=o.item_id)`)
    .bind(row.wishlist_id).all<{ item_id: string; price_cents: number | null; availability: string }>()).results.map(r => [r.item_id, r]));
  const lastPriced = (await env.DB.prepare("SELECT priced_count FROM runs WHERE wishlist_id=? AND status='recorded' AND id<>? ORDER BY started_at DESC LIMIT 1").bind(row.wishlist_id, input.runId).first<{ priced_count: number | null }>())?.priced_count ?? null;
  const priced = input.snapshot.items.filter(i => i.priceCents !== null).length;
  const suspect = looksSystematic(input.snapshot.items.map(i => ({ priceCents: i.priceCents, previousCents: latest.get(stored.get(i.entryId)?.id ?? '')?.price_cents ?? null })))
    ?? (lastPriced !== null && lastPriced >= 20 && priced * 100 < lastPriced * 60 ? `only ${priced} priced items where the last check had ${lastPriced}` : null);
  if (suspect) return recordCheck(env, { runId: input.runId, failure: { ok: false, reason: 'suspect', detail: suspect, pages: input.snapshot.pages, durationMs: input.snapshot.durationMs, usedBrowser: input.snapshot.usedBrowser } });
  // ponytail: history is write-on-change; last_seen_at carries freshness. Revisit if a chart needs per-check samples.
  const staged: D1PreparedStatement[] = [], state: D1PreparedStatement[] = [], alertRows: Record<string, unknown>[] = [], final: D1PreparedStatement[] = [];
  const stateRows: Record<string, unknown>[] = [];
  let alertsCreated = 0;
  for (const item of input.snapshot.items) {
    let prior = stored.get(item.entryId), isNew = false;
    if (!prior) {
      if (!row.add_new_items) continue;
      isNew = true;
      prior = { ...item, id: `${String(row.wishlist_id)}:${item.entryId}`, monitored: 1, baselineCents: item.priceCents, targetCents: null, pctThreshold: 20, alertActive: 0, lastAlertCents: null, priority: null, status: 'active', editionOf: null };
      staged.push(env.DB.prepare('INSERT OR IGNORE INTO items (id,wishlist_id,entry_id,asin,product_url,title,byline,image_url,baseline_cents,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(prior.id, row.wishlist_id, item.entryId, item.asin, item.productUrl, item.title, item.byline, item.imageUrl, item.priceCents, now, now));
    }
    const last = latest.get(prior.id);
    if (!last || last.price_cents !== item.priceCents || last.availability !== item.availability)
      staged.push(env.DB.prepare('INSERT OR IGNORE INTO observations (item_id,run_id,observed_at,price_cents,currency,availability) VALUES (?,?,?,?,?,?)')
        .bind(prior.id, input.runId, now, item.priceCents, item.currency, item.availability));
    const baseline = prior.baselineCents ?? item.priceCents, raw = storedRaw.get(prior.id);
    const decision = prior.monitored && row.monitored && prior.status === 'active' ? decideAlert({ priceCents: isNew || prior.baselineCents === null ? null : item.priceCents, baselineCents: baseline,
      targetCents: prior.editionOf ? raw?.primary_target_cents as number | null : prior.targetCents, pctThreshold: prior.editionOf ? raw?.primary_pct_threshold as number : prior.pctThreshold,
      alertActive: !!prior.alertActive, lastAlertCents: prior.lastAlertCents, redropPct: row.redrop_pct as number | null })
      : { qualifies: false, kind: null, nextAlertActive: !!prior.alertActive };
    const createAlert = decision.qualifies && (!prior.alertActive || decision.kind === 'redrop') && !!decision.kind && item.priceCents !== null && baseline !== null;
    const lastAlertCents = createAlert ? item.priceCents : decision.nextAlertActive ? prior.lastAlertCents : null;
    state.push(env.DB.prepare('UPDATE items SET asin=?,product_url=?,title=?,byline=?,image_url=?,last_seen_at=?,baseline_cents=COALESCE(baseline_cents,?),alert_active=?,last_alert_cents=? WHERE id=?')
      .bind(item.asin, item.productUrl, item.title, item.byline, item.imageUrl, now, item.priceCents, decision.nextAlertActive ? 1 : 0, lastAlertCents, prior.id));
    stateRows.push({ id: prior.id, asin: item.asin, productUrl: item.productUrl, title: item.title, byline: item.byline, imageUrl: item.imageUrl, lastSeenAt: now, priceCents: item.priceCents, alertActive: decision.nextAlertActive ? 1 : 0, lastAlertCents });
    if (createAlert) {
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
        alert_active=(SELECT alert_active FROM changes WHERE changes.id=items.id),last_alert_cents=(SELECT json_extract(value,'$.lastAlertCents') FROM json_each(?) WHERE json_extract(value,'$.id')=items.id) WHERE id IN (SELECT id FROM changes)`).bind(JSON.stringify(stateRows), JSON.stringify(stateRows)));
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
    env.DB.prepare("UPDATE wishlists SET name=?,last_check_at=?,last_success_at=?,last_status='ok',last_error=NULL,next_due_at=? WHERE id=? AND (last_success_at IS NULL OR last_success_at<?)")
      .bind(input.snapshot.name, now, now, nextDue(frequency), row.wishlist_id, row.started_at),
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

export async function getRun(env: Env, userId: string, runId: string) {
  return env.DB.prepare(`SELECT r.id,r.status,r.error,r.item_count,r.priced_count,r.finished_at FROM runs r
    JOIN wishlists w ON w.id=r.wishlist_id WHERE r.id=? AND w.user_id=?`).bind(runId, userId).first();
}
