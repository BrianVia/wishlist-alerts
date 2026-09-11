import { resolveUser } from './identity';
import { sendTestEmail } from './notify';
import { abandonRun, buyNext, deliveriesForWishlist, dueWishlists, getRun, getWishlist, importWishlist, itemHistory, listDeals, listWishlists, requestManualCheck, startRun, updateItem, updateWishlist } from './watches';
export { CheckWorkflow } from './workflow';
export { UsFetcher } from './fetcher';

const json = (value: unknown, status = 200) => Response.json(value, { status });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
async function body(request: Request): Promise<Record<string, unknown> | null> {
  try { const value: unknown = await request.json(); return object(value) ? value : null; } catch { return null; }
}
const only = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every(key => fields.includes(key));
const isoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

async function api(request: Request, env: Env): Promise<Response> {
  const user = await resolveUser(request, env);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/api/me') return json(user);
  if (request.method === 'GET' && path === '/api/wishlists') return json(await listWishlists(env, user.id));
  if (request.method === 'GET' && path === '/api/deals') return json(await listDeals(env, user.id));
  if (request.method === 'GET' && path === '/api/buy-next') {
    const budget = Number(url.searchParams.get('budget'));
    return Number.isInteger(budget) && budget >= 500 && budget <= 1_000_000 ? json(await buyNext(env, user.id, budget)) : json({ error: 'invalid_request' }, 400);
  }
  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && request.method === 'GET') {
    const run = await getRun(env, user.id, runMatch[1]);
    return run ? json(run) : json({ error: 'not_found' }, 404);
  }
  if (request.method === 'POST' && path === '/api/wishlists') {
    const data = await body(request);
    if (!data || !only(data, ['url', 'frequency', 'addNewItems']) || typeof data.url !== 'string'
      || (data.frequency !== undefined && !['daily', 'hourly'].includes(data.frequency as string))
      || (data.addNewItems !== undefined && typeof data.addNewItems !== 'boolean')) return json({ error: 'invalid_request' }, 400);
    const result = await importWishlist(env, user.id, { url: data.url, frequency: (data.frequency ?? 'daily') as 'daily' | 'hourly', addNewItems: data.addNewItems === undefined ? true : data.addNewItems });
    return 'error' in result ? json({ error: result.error.reason, detail: result.error.detail }, 422) : json(result, 201);
  }
  if (request.method === 'POST' && path === '/api/test-email') return json(await sendTestEmail(env, user.id));

  const wishlistMatch = path.match(/^\/api\/wishlists\/([^/]+)$/);
  if (wishlistMatch && request.method === 'GET') {
    const result = await getWishlist(env, user.id, wishlistMatch[1]);
    if (!result) return json({ error: 'not_found' }, 404);
    return json({ ...result, deliveries: await deliveriesForWishlist(env, user.id, wishlistMatch[1]) });
  }
  if (wishlistMatch && request.method === 'PATCH') {
    const data = await body(request);
    if (!data || !only(data, ['monitored', 'frequency', 'addNewItems', 'name', 'redropPct'])
      || (data.monitored !== undefined && typeof data.monitored !== 'boolean')
      || (data.addNewItems !== undefined && typeof data.addNewItems !== 'boolean')
      || (data.frequency !== undefined && !['daily', 'hourly'].includes(data.frequency as string))
      || (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200))
      || (data.redropPct !== undefined && data.redropPct !== null && (!Number.isInteger(data.redropPct) || (data.redropPct as number) < 5 || (data.redropPct as number) > 90))) return json({ error: 'invalid_request' }, 400);
    const result = await updateWishlist(env, user.id, wishlistMatch[1], { ...data, name: typeof data.name === 'string' ? data.name.trim() : undefined });
    return result ? json(result) : json({ error: 'not_found' }, 404);
  }
  const checkMatch = path.match(/^\/api\/wishlists\/([^/]+)\/check$/);
  if (checkMatch && request.method === 'POST') {
    const requested = await requestManualCheck(env, user.id, checkMatch[1], Date.now());
    if ('error' in requested) return json({ error: requested.error }, requested.error === 'rate_limited' ? 429 : requested.error === 'busy' || requested.error === 'paused' ? 409 : 404);
    const wishlist = await getWishlist(env, user.id, checkMatch[1]);
    const source = (wishlist?.wishlist as { source_url?: string } | undefined)?.source_url;
    if (!source) return json({ error: 'not_found' }, 404);
    try { await env.CHECK_WORKFLOW.create({ id: requested.runId, params: { wishlistId: checkMatch[1], runId: requested.runId, url: source } }); }
    catch (error) { console.error('manual workflow dispatch failed', error); await abandonRun(env, requested.runId); return json({ error: 'dispatch_failed' }, 503); }
    return json(requested, 202);
  }
  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && request.method === 'PATCH') {
    const data = await body(request);
    if (!data || !only(data, ['monitored', 'targetCents', 'pctThreshold', 'priority', 'status', 'snoozedUntil', 'editionOf'])
      || (data.monitored !== undefined && typeof data.monitored !== 'boolean')
      || (data.targetCents !== undefined && data.targetCents !== null && (!Number.isInteger(data.targetCents) || (data.targetCents as number) < 0))
      || (data.pctThreshold !== undefined && (!Number.isInteger(data.pctThreshold) || (data.pctThreshold as number) < 1 || (data.pctThreshold as number) > 99))
      || (data.priority !== undefined && data.priority !== null && !['must', 'interested', 'someday'].includes(data.priority as string))
      || (data.status !== undefined && !['active', 'bought', 'dropped', 'snoozed'].includes(data.status as string))
      || (data.snoozedUntil !== undefined && data.snoozedUntil !== null && !isoDate(data.snoozedUntil))
      || (data.status === 'snoozed' && !isoDate(data.snoozedUntil))
      || (data.editionOf !== undefined && data.editionOf !== null && typeof data.editionOf !== 'string')) return json({ error: 'invalid_request' }, 400);
    const result = await updateItem(env, user.id, itemMatch[1], data);
    return result && 'error' in result ? json(result, 400) : result ? json(result) : json({ error: 'not_found' }, 404);
  }
  const historyMatch = path.match(/^\/api\/items\/([^/]+)\/history$/);
  if (historyMatch && request.method === 'GET') {
    const result = await itemHistory(env, user.id, historyMatch[1]);
    return result ? json(result) : json({ error: 'not_found' }, 404);
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  fetch(request: Request, env: Env) { return new URL(request.url).pathname.startsWith('/api/') ? api(request, env) : env.ASSETS.fetch(request); },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const slot = new Date(controller.scheduledTime).toISOString().slice(0, 13);
      for (const wishlist of await dueWishlists(env, controller.scheduledTime)) {
        const runId = `${wishlist.id}_${slot}`;
        if (!await startRun(env, { wishlistId: wishlist.id, runId, trigger: 'scheduled', startedAt: new Date(controller.scheduledTime).toISOString() })) continue;
        try { await env.CHECK_WORKFLOW.create({ id: runId, params: { wishlistId: wishlist.id, runId, url: wishlist.url } }); }
        catch (error) { console.error('scheduled workflow dispatch failed', { wishlistId: wishlist.id, error }); await abandonRun(env, runId); }
      }
    })());
  },
} satisfies ExportedHandler<Env>;
