import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotItem } from '../src/collect';
import { alertsForRun, buyNext, deliveriesForWishlist, getWishlist, importWishlist, itemHistory, recordCheck, requestManualCheck, startRun, updateItem, updateWishlist } from '../src/watches';

const item = (entryId: string, priceCents: number | null): SnapshotItem => ({ entryId, asin: 'B012345678', productUrl: 'https://www.amazon.com/dp/B012345678', title: `Item ${entryId}`, byline: null, imageUrl: null, priceCents, currency: 'USD', availability: priceCents === null ? 'no_price' : 'priced' });
const snapshot = (...items: SnapshotItem[]): Snapshot => ({ ok: true, url: 'https://www.amazon.com/hz/wishlist/ls/ABC123', name: 'Test list', items, pages: 1, complete: true, durationMs: 5, usedBrowser: false });
async function user(id: string) { await env.DB.prepare('INSERT INTO users VALUES (?,?,?,?)').bind(id, `auth:${id}`, `${id}@example.com`, new Date().toISOString()).run(); }
async function imported(initial: SnapshotItem[] = [item('one', 10_000)]) {
  await user('a');
  const result = await importWishlist(env, 'a', { url: 'https://amazon.com/hz/wishlist/ls/ABC123', frequency: 'hourly', addNewItems: true }, async () => snapshot(...initial));
  if ('error' in result) throw new Error(result.error.detail);
  return result as { wishlist: { id: string }; items: Array<{ id: string }> };
}
async function check(wishlistId: string, suffix: string, result: Snapshot, offset: number) {
  const runId = `${wishlistId}:${suffix}`;
  expect(await startRun(env, { wishlistId, runId, trigger: 'scheduled', startedAt: new Date(Date.now() + offset).toISOString() })).toBe(true);
  await recordCheck(env, { runId, snapshot: result });
  return runId;
}

describe('owner-scoped persistence and transitions', () => {
  it('does not expose another owner’s list, item, history, checks, or deliveries', async () => {
    const list = await imported(); await user('b'); const itemId = list.items[0].id;
    expect(await getWishlist(env, 'b', list.wishlist.id)).toBeNull();
    expect(await updateWishlist(env, 'b', list.wishlist.id, { monitored: false })).toBeNull();
    expect(await updateItem(env, 'b', itemId, { monitored: false })).toBeNull();
    expect(await itemHistory(env, 'b', itemId)).toBeNull();
    expect(await requestManualCheck(env, 'b', list.wishlist.id, Date.now())).toEqual({ error: 'not_found' });
    expect(await deliveriesForWishlist(env, 'b', list.wishlist.id)).toBeNull();
  });

  it('makes repeat imports and new-item discovery idempotent', async () => {
    const first = await imported();
    const second = await importWishlist(env, 'a', { url: 'https://www.amazon.com/hz/wishlist/ls/ABC123', frequency: 'daily', addNewItems: true }, async () => snapshot(item('one', 9000), item('two', 5000)));
    if ('error' in second) throw new Error(second.error.detail);
    expect((second.wishlist as { id: string }).id).toBe(first.wishlist.id);
    expect(second.items).toHaveLength(2);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM items').first<{ count: number }>())?.count).toBe(2);
  });

  it('sets a delayed baseline without alerting, then fires once and rearms', async () => {
    const list = await imported([item('one', null)]), id = list.wishlist.id;
    await check(id, 'baseline', snapshot(item('one', 10_000)), 10_000);
    expect((await getWishlist(env, 'a', id))!.items[0]).toMatchObject({ baseline_cents: 10_000 });
    expect(await alertsForRun(env, `${id}:baseline`)).toHaveLength(0);
    const drop1 = await check(id, 'drop1', snapshot(item('one', 7999)), 20_000);
    expect(await alertsForRun(env, drop1)).toHaveLength(1);
    expect((await env.DB.prepare('SELECT status FROM deliveries WHERE run_id=?').bind(drop1).first<{ status: string }>())?.status).toBe('pending');
    const same = await check(id, 'same', snapshot(item('one', 7999)), 30_000);
    expect(await alertsForRun(env, same)).toHaveLength(0);
    await check(id, 'recover', snapshot(item('one', 9000)), 40_000);
    const drop2 = await check(id, 'drop2', snapshot(item('one', 7999)), 50_000);
    expect(await alertsForRun(env, drop2)).toHaveLength(1);
  });

  it('records opt-in further-drop alerts and clears their anchor on recovery', async () => {
    const list = await imported(), id = list.wishlist.id, itemId = list.items[0].id;
    await updateWishlist(env, 'a', id, { redropPct: 20 });
    await check(id, 'drop', snapshot(item('one', 7900)), 10_000);
    expect((await env.DB.prepare('SELECT last_alert_cents FROM items WHERE id=?').bind(itemId).first())).toMatchObject({ last_alert_cents: 7900 });
    expect(await alertsForRun(env, await check(id, 'not-enough', snapshot(item('one', 7000)), 20_000))).toHaveLength(0);
    const redrop = await check(id, 'redrop', snapshot(item('one', 4000)), 30_000);
    expect(await alertsForRun(env, redrop)).toMatchObject([{ kind: 'redrop', price_cents: 4000 }]);
    expect((await env.DB.prepare('SELECT last_alert_cents FROM items WHERE id=?').bind(itemId).first())).toMatchObject({ last_alert_cents: 4000 });
    await check(id, 'recover-redrop', snapshot(item('one', 9000)), 40_000);
    expect((await env.DB.prepare('SELECT alert_active,last_alert_cents FROM items WHERE id=?').bind(itemId).first())).toMatchObject({ alert_active: 0, last_alert_cents: null });
  });

  it('ranks affordable priorities and validates edition links', async () => {
    const list = await imported([item('one', 4000), item('two', 3000)]), [one, two] = list.items;
    await updateItem(env, 'a', one.id, { priority: 'must' });
    await updateItem(env, 'a', two.id, { targetCents: 3000 });
    const plan = await buyNext(env, 'a', 6000);
    expect(plan.picks.map(pick => pick.item.id)).toEqual([one.id]);
    expect(plan).toMatchObject({ leftoverCents: 2000, skipped: 1 });
    expect(await updateItem(env, 'a', two.id, { editionOf: one.id })).toMatchObject({ edition_of: one.id });
    expect(await updateItem(env, 'a', one.id, { editionOf: two.id })).toEqual({ error: 'edition_chain' });
  });

  it('hides snoozed feedback and reactivates it on a later check', async () => {
    const list = await imported(), id = list.wishlist.id, itemId = list.items[0].id;
    await updateItem(env, 'a', itemId, { priority: 'must', status: 'snoozed', snoozedUntil: '2000-01-01' });
    expect((await buyNext(env, 'a', 20_000)).picks).toHaveLength(0);
    await check(id, 'wake', snapshot(item('one', 10_000)), 10_000);
    expect((await env.DB.prepare('SELECT status,snoozed_until FROM items WHERE id=?').bind(itemId).first())).toMatchObject({ status: 'active', snoozed_until: null });
    await updateItem(env, 'a', itemId, { status: 'bought' });
    expect((await env.DB.prepare('SELECT status,monitored FROM items WHERE id=?').bind(itemId).first())).toMatchObject({ status: 'bought', monitored: 0 });
  });

  it('preserves facts on failure and rejects duplicate and stale runs', async () => {
    const list = await imported(), id = list.wishlist.id, runId = `${id}:failure`;
    expect(await startRun(env, { wishlistId: id, runId, trigger: 'scheduled' })).toBe(true);
    expect(await startRun(env, { wishlistId: id, runId, trigger: 'scheduled' })).toBe(false);
    await recordCheck(env, { runId, failure: { ok: false, reason: 'blocked', detail: 'captcha', pages: 1, durationMs: 4, usedBrowser: false } });
    await recordCheck(env, { runId, snapshot: snapshot(item('one', 1)) });
    expect((await getWishlist(env, 'a', id))!.wishlist).toMatchObject({ last_status: 'blocked', last_error: 'captcha' });
    expect((await getWishlist(env, 'a', id))!.items[0]).toMatchObject({ current_cents: 10_000 });
    const staleId = `${id}:stale`;
    await startRun(env, { wishlistId: id, runId: staleId, trigger: 'scheduled', startedAt: '2000-01-01T00:00:00.000Z' });
    await recordCheck(env, { runId: staleId, snapshot: snapshot(item('one', 1)) });
    expect((await env.DB.prepare('SELECT status,error FROM runs WHERE id=?').bind(staleId).first())).toMatchObject({ status: 'failed', error: 'stale' });
  });

  it('writes history only when the price or availability changes', async () => {
    const list = await imported(), id = list.wishlist.id, itemId = list.items[0].id;
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) count FROM observations WHERE item_id=?').bind(itemId).first<{ count: number }>())!.count;
    await check(id, 'same1', snapshot(item('one', 10_000)), 10_000);
    await check(id, 'same2', snapshot(item('one', 10_000)), 20_000);
    expect(await count()).toBe(1);
    await check(id, 'changed', snapshot(item('one', 9_500)), 30_000);
    expect(await count()).toBe(2);
    await check(id, 'gone', snapshot({ ...item('one', null), availability: 'unavailable' }), 40_000);
    expect(await count()).toBe(3);
    const view = (await getWishlist(env, 'a', id))!.items[0] as { observed_at: string; current_cents: number | null };
    expect(view.current_cents).toBeNull();
    expect(Date.parse(view.observed_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('rejects a run whose priced count collapsed versus the last check', async () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`e${i}`, 1000 + i));
    const list = await imported(many), id = list.wishlist.id;
    const runId = await check(id, 'collapse', snapshot(...many.map((it, i) => (i < 10 ? it : { ...it, priceCents: null, availability: 'no_price' as const }))), 10_000);
    expect(await env.DB.prepare('SELECT status,error FROM runs WHERE id=?').bind(runId).first()).toMatchObject({ status: 'failed', error: 'suspect' });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM observations').first<{ n: number }>())!.n).toBe(30);
  });

  it('stages large checks but commits success state in the final batch', async () => {
    const list = await imported(), id = list.wishlist.id;
    const items = Array.from({ length: 101 }, (_, index) => item(index ? `new-${index}` : 'one', 10_000 - index));
    const runId = await check(id, 'large', snapshot(...items), 10_000);
    expect((await env.DB.prepare('SELECT status,item_count FROM runs WHERE id=?').bind(runId).first())).toMatchObject({ status: 'recorded', item_count: 101 });
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM observations WHERE run_id=?').bind(runId).first<{ count: number }>())?.count).toBe(100);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM items WHERE wishlist_id=?').bind(id).first<{ count: number }>())?.count).toBe(101);
  });

  it('publishes observations only after their run is recorded', async () => {
    const list = await imported(), id = list.wishlist.id, itemId = list.items[0].id, runId = `${id}:staged`;
    await startRun(env, { wishlistId: id, runId, trigger: 'scheduled' });
    await env.DB.prepare("INSERT INTO observations VALUES (?,?,?,?,?,'priced')").bind(itemId, runId, new Date(Date.now() + 1000).toISOString(), 5000, 'USD').run();
    expect((await getWishlist(env, 'a', id))!.items[0]).toMatchObject({ current_cents: 10_000 });
    expect(await itemHistory(env, 'a', itemId)).toHaveLength(1);
    await recordCheck(env, { runId, snapshot: snapshot(item('one', 5000)) });
    expect((await getWishlist(env, 'a', id))!.items[0]).toMatchObject({ current_cents: 5000 });
    expect(await itemHistory(env, 'a', itemId)).toHaveLength(2);
  });

  it('leases one active run per wishlist for fifteen minutes', async () => {
    const list = await imported(), id = list.wishlist.id;
    expect(await startRun(env, { wishlistId: id, runId: 'active-1', trigger: 'manual' })).toBe(true);
    expect(await startRun(env, { wishlistId: id, runId: 'active-2', trigger: 'manual' })).toBe(false);
    expect(await requestManualCheck(env, 'a', id, Date.now())).toEqual({ error: 'busy' });
    await recordCheck(env, { runId: 'active-1', snapshot: snapshot(item('one', 10_000)) });
    expect(await startRun(env, { wishlistId: id, runId: 'active-3', trigger: 'manual' })).toBe(true);
    await recordCheck(env, { runId: 'active-3', snapshot: snapshot(item('one', 10_000)) });
    expect(await startRun(env, { wishlistId: id, runId: 'expired', trigger: 'manual', startedAt: new Date(Date.now() - 1_200_000).toISOString() })).toBe(true);
    expect(await startRun(env, { wishlistId: id, runId: 'after-expired', trigger: 'manual' })).toBe(true);
  });
});
