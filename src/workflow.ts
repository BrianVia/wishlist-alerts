import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { collectWishlist } from './collect';
import { deliverPending } from './notify';
import { recordCheck } from './watches';

type Params = { wishlistId: string; runId: string; url: string };

export class CheckWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { runId, url } = event.payload;
    const result = await step.do('collect', { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '4 minutes' }, () => collectWishlist(url, this.env));
    await step.do('record', { retries: { limit: 3, delay: '10 seconds' } }, () => recordCheck(this.env, result.ok ? { runId, snapshot: result } : { runId, failure: result }));
    return step.do('deliver', { retries: { limit: 1, delay: '30 seconds' } }, () => deliverPending(this.env, runId));
  }
}
