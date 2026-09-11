import { priceContext } from './watches';

type DeliveryResult = { status: 'sent' | 'failed' | 'skipped'; messageId?: string };

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function deliverPending(env: Env, runId: string): Promise<DeliveryResult> {
  const delivery = await env.DB.prepare("UPDATE deliveries SET status='sending',attempts=attempts+1 WHERE run_id=? AND status IN ('pending','sending') AND attempts<2 RETURNING *")
    .bind(runId).first<Record<string, unknown>>();
  if (!delivery) return { status: 'skipped' };
  const wishlist = await env.DB.prepare('SELECT w.name,w.monitored,u.email FROM wishlists w JOIN users u ON u.id=w.user_id WHERE w.id=?').bind(delivery.wishlist_id).first<{ name: string; monitored: number; email: string }>();
  if (!wishlist || !wishlist.monitored) {
    await env.DB.prepare("UPDATE deliveries SET status='failed',last_error='wishlist paused or owner missing' WHERE run_id=?").bind(runId).run();
    return { status: 'skipped' };
  }
  const alerts = (await env.DB.prepare('SELECT * FROM alerts WHERE run_id=? ORDER BY title').bind(runId).all<Record<string, unknown>>()).results;
  if (!alerts.length) {
    await env.DB.prepare("UPDATE deliveries SET status='failed',last_error='no alerts' WHERE run_id=?").bind(runId).run();
    return { status: 'skipped' };
  }
  const history = (await env.DB.prepare(`SELECT o.item_id,o.observed_at,o.price_cents,i.last_seen_at FROM observations o
    JOIN runs r ON r.id=o.run_id AND r.status='recorded' JOIN items i ON i.id=o.item_id
    WHERE o.item_id IN (SELECT item_id FROM alerts WHERE run_id=?) ORDER BY o.observed_at`).bind(runId).all<Record<string, unknown>>()).results;
  const context = new Map<string, ReturnType<typeof priceContext>>();
  for (const alert of alerts) {
    const rows = history.filter(row => row.item_id === alert.item_id).map(row => ({ observed_at: row.observed_at as string, price_cents: row.price_cents as number | null }));
    context.set(alert.item_id as string, priceContext(rows, (history.find(row => row.item_id === alert.item_id)?.last_seen_at as string | undefined) ?? alert.created_at as string));
  }
  const line = (alert: Record<string, unknown>) => {
    const baseline = alert.baseline_cents as number, price = alert.price_cents as number, ctx = context.get(alert.item_id as string)!;
    const historyText = ctx.coverage === 'ok' ? `usually about ${dollars(ctx.typicalCents!)} over ${Math.floor(ctx.daysObserved)} days · lowest ${dollars(ctx.lowestCents!)}` : `only ${Math.floor(ctx.daysObserved)} days of history`;
    return `Was ${dollars(baseline)} (first seen) · ${historyText} · now ${dollars(price)} (${Math.round((1 - price / baseline) * 100)}% off)`;
  };
  const subject = `Price drop: ${alerts.length} item(s) on ${wishlist.name.replace(/[\r\n]+/g, ' ')}`;
  const htmlItems = alerts.map(alert => {
    const link = (alert.product_url as string).startsWith('https://www.amazon.com/') ? `<br><a href="${escapeHtml(alert.product_url as string)}">View on Amazon</a>` : '';
    const target = alert.kind === 'target' || alert.kind === 'both' ? '<br>Target price reached.' : '';
    return `<li><strong>${escapeHtml(alert.title as string)}</strong><br>${line(alert)}${target}${link}</li>`;
  }).join('');
  const textItems = alerts.map(alert => {
    const link = (alert.product_url as string).startsWith('https://www.amazon.com/') ? `\n${alert.product_url}` : '';
    const target = alert.kind === 'target' || alert.kind === 'both' ? '\nTarget price reached.' : '';
    return `${alert.title}\n${line(alert)}${target}${link}`;
  }).join('\n\n');
  try {
    const sent = await env.EMAIL.send({
      to: wishlist.email, from: env.EMAIL_FROM, subject,
      html: `<h1>${escapeHtml(subject)}</h1><ul>${htmlItems}</ul><p>Discount is vs. the first price we saw, not Amazon's list price.</p>`,
      text: `${subject}\n\n${textItems}\n\nDiscount is vs. the first price we saw, not Amazon's list price.`,
    });
    await env.DB.prepare("UPDATE deliveries SET status='sent',provider_message_id=?,sent_at=?,last_error=NULL WHERE run_id=?").bind(sent.messageId, new Date().toISOString(), runId).run();
    return { status: 'sent', messageId: sent.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email delivery failed';
    await env.DB.prepare("UPDATE deliveries SET status=CASE WHEN attempts<2 THEN 'pending' ELSE 'failed' END,last_error=? WHERE run_id=?").bind(message, runId).run();
    if ((delivery.attempts as number) < 2) throw error;
    return { status: 'failed' };
  }
}

export async function sendTestEmail(env: Env, userId: string): Promise<DeliveryResult> {
  const user = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(userId).first<{ email: string }>();
  if (!user) return { status: 'skipped' };
  try {
    const sent = await env.EMAIL.send({ to: user.email, from: env.EMAIL_FROM, subject: 'Wishlist Alerts test', html: '<p>Your Wishlist Alerts email is working.</p>', text: 'Your Wishlist Alerts email is working.' });
    return { status: 'sent', messageId: sent.messageId };
  } catch { return { status: 'failed' }; }
}
