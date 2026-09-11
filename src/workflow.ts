import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { collectWishlist, type CollectionFailure, type CollectionResult } from './collect';
import { deliverPending } from './notify';
import { recordCheck } from './watches';

type Params = { wishlistId: string; runId: string; url: string };
const transient = new Set<CollectionFailure['reason']>(['timeout', 'blocked', 'partial', 'parse_error', 'currency']);
let collector: (url: string, env: Env) => Promise<CollectionResult> = collectWishlist;

export function setCollector(fn: typeof collector) { collector = fn; }

export class CheckWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { runId, url } = event.payload;
    let failure: CollectionFailure | undefined;
    try {
      const result = await step.do('collect', { retries: { limit: 3, delay: '2 minutes', backoff: 'exponential' }, timeout: '4 minutes' }, async () => {
        const collected = await collector(url, this.env);
        if (!collected.ok && transient.has(collected.reason)) { failure = collected; throw new Error(collected.detail); }
        return collected;
      });
      await step.do('record', { retries: { limit: 3, delay: '10 seconds' } }, () => recordCheck(this.env, result.ok ? { runId, snapshot: result } : { runId, failure: result }));
    } catch (error) {
      failure ??= { ok: false, reason: 'timeout', detail: error instanceof Error ? error.message : 'Collection failed', pages: 0, durationMs: 0, usedBrowser: false };
      await step.do('record failure', { retries: { limit: 3, delay: '10 seconds' } }, () => recordCheck(this.env, { runId, failure }));
    }
    return step.do('deliver', { retries: { limit: 1, delay: '1 minute' } }, () => deliverPending(this.env, runId));
  }
}
