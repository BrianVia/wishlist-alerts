import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { deliverPending } from '../src/notify';

async function seed(title = '<script>alert(1)</script>', productUrl = 'https://evil.example/item') {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users VALUES (?,?,?,?)').bind('u', 'auth:u', 'owner@example.com', now),
    env.DB.prepare('INSERT INTO wishlists (id,user_id,source_url,name,next_due_at,created_at) VALUES (?,?,?,?,?,?)').bind('w', 'u', 'https://www.amazon.com/hz/wishlist/ls/ABC', 'My List', now, now),
    env.DB.prepare("INSERT INTO runs (id,wishlist_id,trigger,status,started_at) VALUES ('r','w','manual','recorded',?)").bind(now),
    env.DB.prepare("INSERT INTO items (id,wishlist_id,entry_id,product_url,title,baseline_cents,created_at) VALUES ('i','w','e',?,?,10000,?)").bind(productUrl, title, now),
    env.DB.prepare("INSERT INTO alerts VALUES ('r:i','w','i','r','both',10000,7000,?,?,?)").bind(title, productUrl, now),
    env.DB.prepare("INSERT INTO deliveries (id,wishlist_id,run_id,recipient,status,created_at) VALUES ('r','w','r','owner@example.com','pending',?)").bind(now),
  ]);
}
const withEmail = (send: (message: unknown) => Promise<{ messageId: string }>) => ({ DB: env.DB, EMAIL: { send }, EMAIL_FROM: 'alerts@example.com' }) as unknown as Env;

describe('batched delivery', () => {
  it('sends once, records the message ID, escapes titles, and drops unsafe links', async () => {
    await seed(); const send = vi.fn(async (_message: unknown) => ({ messageId: 'message-1' }));
    expect(await deliverPending(withEmail(send), 'r')).toEqual({ status: 'sent', messageId: 'message-1' });
    const message = send.mock.calls[0][0] as { html: string };
    expect(message.html).toContain('&lt;script&gt;'); expect(message.html).not.toContain('https://evil.example');
    expect((await env.DB.prepare('SELECT status,provider_message_id FROM deliveries WHERE id=\'r\'').first())).toMatchObject({ status: 'sent', provider_message_id: 'message-1' });
  });
  it('retries one provider failure, then stops failed', async () => {
    await seed('Safe', 'https://www.amazon.com/dp/B012345678'); const send = vi.fn(async (_message: unknown) => { throw new Error('provider down'); }); const testEnv = withEmail(send);
    await expect(deliverPending(testEnv, 'r')).rejects.toThrow('provider down');
    expect((await env.DB.prepare("SELECT status,attempts FROM deliveries WHERE id='r'").first())).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await deliverPending(testEnv, 'r')).status).toBe('failed');
    expect((await env.DB.prepare("SELECT status,attempts FROM deliveries WHERE id='r'").first())).toMatchObject({ status: 'failed', attempts: 2 });
    expect((await deliverPending(testEnv, 'r')).status).toBe('skipped');
  });
});
