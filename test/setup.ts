import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach, inject } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare module 'vitest' { export interface ProvidedContext { migrations: D1Migration[] } }
beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await env.DB.batch(['deliveries', 'alerts', 'observations', 'runs', 'items', 'wishlists', 'users'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});
