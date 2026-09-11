import { env, type WorkflowStep } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { collectWishlist, type CollectionFailure, type CollectionResult, type Snapshot } from '../src/collect';
import { importWishlist, startRun } from '../src/watches';
import { CheckWorkflow, setCollector } from '../src/workflow';

const item = { entryId: 'one', asin: null, productUrl: 'https://www.amazon.com/dp/B012345678', title: 'One', byline: null, imageUrl: null, priceCents: 1000, currency: 'USD' as const, availability: 'priced' as const };
const snapshot: Snapshot = { ok: true, url: 'https://www.amazon.com/hz/wishlist/ls/ABC', name: 'List', items: [item], pages: 1, complete: true, durationMs: 1, usedBrowser: false };
const failed = (reason: CollectionFailure['reason']): CollectionFailure => ({ ok: false, reason, detail: reason, pages: 1, durationMs: 1, usedBrowser: false });

async function seeded(runId: string) {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users VALUES (?,?,?,?)').bind('u', 'auth:u', 'u@example.com', now).run();
  const imported = await importWishlist(env, 'u', { url: snapshot.url, frequency: 'daily', addNewItems: true }, async () => snapshot);
  if ('error' in imported) throw new Error(imported.error.detail);
  const wishlistId = (imported.wishlist as { id: string }).id;
  await startRun(env, { wishlistId, runId, trigger: 'manual' });
  return wishlistId;
}

function fakeStep() {
  return { do: async (_name: string, options: { retries?: { limit: number } }, fn: () => Promise<unknown>) => {
    let attempt = 0;
    while (true) try { return await fn(); } catch (error) { if (attempt++ >= (options.retries?.limit ?? 0)) throw error; }
  } } as unknown as WorkflowStep;
}

async function run(runId: string) {
  const wishlistId = await seeded(runId);
  const workflow = Object.assign(Object.create(CheckWorkflow.prototype) as CheckWorkflow, { env });
  await workflow.run({ payload: { wishlistId, runId, url: snapshot.url }, timestamp: new Date(), instanceId: runId, workflowName: 'test' }, fakeStep());
  return env.DB.prepare('SELECT status,error FROM runs WHERE id=?').bind(runId).first();
}

afterEach(() => setCollector(collectWishlist));

describe('check workflow retries', () => {
  it('retries transient collection failures until recorded', async () => {
    let calls = 0;
    setCollector(async () => ++calls < 3 ? failed('blocked') : snapshot);
    expect(await run('retry-success')).toMatchObject({ status: 'recorded' });
    expect(calls).toBe(3);
  });

  it('records the last failure after retries are exhausted', async () => {
    let calls = 0;
    setCollector(async () => { calls++; return failed('partial'); });
    expect(await run('retry-failed')).toMatchObject({ status: 'failed', error: 'partial' });
    expect(calls).toBe(4);
  });

  it('does not retry terminal collection failures', async () => {
    let calls = 0;
    setCollector(async () => { calls++; return failed('private'); });
    expect(await run('terminal')).toMatchObject({ status: 'failed', error: 'private' });
    expect(calls).toBe(1);
  });
});
