import { DurableObject } from 'cloudflare:workers';

// Amazon localizes prices, currency, and deliverability by the requesting IP. Cloudflare may run a
// check from any colo, so route page fetches through a Durable Object pinned to US East.
export class UsFetcher extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}

export function usFetch(env: Env): typeof fetch {
  if (!env.US_FETCH) return fetch;
  const stub = env.US_FETCH.get(env.US_FETCH.idFromName('us-east'), { locationHint: 'enam' });
  return (input, init) => stub.fetch(new Request(input, init));
}
