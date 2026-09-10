import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    // The pool's bundled local runtime trails Wrangler's release by 16 days.
    miniflare: { compatibilityDate: '2026-08-22' },
  })],
  test: {
    setupFiles: ['./test/setup.ts'],
    provide: { migrations: await readD1Migrations('./migrations') },
  },
}));
