import puppeteer from '@cloudflare/puppeteer';
import { load } from 'cheerio';

export type SnapshotItem = {
  entryId: string; asin: string | null; productUrl: string; title: string;
  byline: string | null; imageUrl: string | null; priceCents: number | null;
  currency: 'USD'; availability: 'priced' | 'unavailable' | 'no_price';
};
export type Snapshot = { ok: true; url: string; name: string; items: SnapshotItem[]; pages: number; complete: true; durationMs: number; usedBrowser: boolean };
export type CollectionFailure = { ok: false; reason: 'blocked' | 'login_required' | 'not_found' | 'private' | 'timeout' | 'partial' | 'parse_error' | 'invalid_url' | 'currency' | 'suspect'; detail: string; pages: number; durationMs: number; usedBrowser: boolean };
export type CollectionResult = Snapshot | CollectionFailure;

const MAX_PAGES = 150, MAX_ITEMS = 1500, MAX_MS = 180_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export function canonicalizeWishlistUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/hz\/wishlist\/ls\/([A-Za-z0-9]+)\/?$/);
    return url.protocol === 'https:' && ['amazon.com', 'www.amazon.com'].includes(url.hostname) && match
      ? `https://www.amazon.com/hz/wishlist/ls/${match[1]}` : null;
  } catch { return null; }
}

function money(text: string | undefined): number | null {
  const match = text?.trim().match(/^\$\s?([\d,]+)\.(\d{2})$/);
  return match ? Number(match[1].replaceAll(',', '')) * 100 + Number(match[2]) : null;
}

export function parseWishlistPage(html: string): { name: string; items: SnapshotItem[]; nextUrl: string | null; endOfList: boolean; state: 'list' | 'blocked' | 'login' | 'not_found' | 'private' | 'unknown'; foreignCurrency: string | null } {
  const $ = load(html);
  const title = $('title').text().trim();
  if ($('#captchacharacters').length || /Robot Check|Sorry! Something went wrong/i.test(title)) return { name: title, items: [], nextUrl: null, endOfList: false, state: 'blocked', foreignCurrency: null };
  if ($('#ap_email').length) return { name: title, items: [], nextUrl: null, endOfList: false, state: 'login', foreignCurrency: null };
  if (/Page Not Found|404/i.test(title)) return { name: title, items: [], nextUrl: null, endOfList: false, state: 'not_found', foreignCurrency: null };
  if (!$('#g-items').length && /not a functioning page/i.test($('body').text())) return { name: title, items: [], nextUrl: null, endOfList: false, state: 'private', foreignCurrency: null };
  if (!$('#g-items').length) return { name: title, items: [], nextUrl: null, endOfList: false, state: 'unknown', foreignCurrency: null };

  const items: SnapshotItem[] = [];
  let foreign: string | null = null;
  $('ul#g-items > li[data-itemid], ul#g-items > li.g-item-sortable[data-itemid]').each((_, node) => {
    const li = $(node), entryId = li.attr('data-itemid');
    const link = li.find('a[id^="itemName_"]').first();
    const href = link.attr('href');
    if (!entryId || !href) return;
    let productUrl: string;
    try {
      const u = new URL(href, 'https://www.amazon.com');
      if (u.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(u.hostname)) return;
      u.hostname = 'www.amazon.com'; u.search = ''; u.hash = ''; productUrl = u.toString();
    } catch { return; }
    const unavailable = /Currently unavailable/i.test(li.text()) || li.find('.itemUnavailable').length > 0;
    const offscreen = li.find('span.a-price > span.a-offscreen').first().text();
    const symbol = li.find('span.a-price-symbol').first().text().trim();
    const whole = li.find('span.a-price-whole').first().text().replace(/[,.\s]/g, ''), fraction = li.find('span.a-price-fraction').first().text().trim();
    if (offscreen && !offscreen.trim().startsWith('$')) foreign ||= offscreen.trim().replace(/[\d.,\s]/g, '') || 'unknown';
    if (symbol && symbol !== '$') foreign ||= symbol;
    const priceCents = money(offscreen) ?? (symbol === '$' && whole && fraction ? money(`$${whole}.${fraction}`) : null) ?? money(li.attr('data-price'));
    const byline = li.find('[id]').filter((_, child) => $(child).attr('id') === `item-byline-${entryId}`).text().trim().replace(/^by\s+/i, '') || null;
    items.push({
      entryId, asin: href.match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() ?? null,
      productUrl, title: link.attr('title')?.trim() || link.text().trim(), byline,
      imageUrl: li.find('img').first().attr('src') ?? null, priceCents: unavailable ? null : priceCents,
      currency: 'USD', availability: unavailable ? 'unavailable' : priceCents === null ? 'no_price' : 'priced',
    });
  });
  return {
    name: $('#profile-list-name').text().trim() || title,
    items,
    nextUrl: $('input.showMoreUrl, #showMoreUrl').first().attr('value') ?? null,
    endOfList: $('#endOfListMarker').length > 0,
    state: 'list',
    foreignCurrency: foreign,
  };
}

function failure(reason: CollectionFailure['reason'], detail: string, pages: number, started: number, usedBrowser: boolean): CollectionFailure {
  return { ok: false, reason, detail, pages, durationMs: Date.now() - started, usedBrowser };
}

function nextPageUrl(value: string, listId: string): string | null {
  try {
    const url = new URL(value, 'https://www.amazon.com');
    const listPage = url.pathname.replace(/\/$/, '') === `/hz/wishlist/ls/${listId}`;
    const cursorPage = url.pathname === '/hz/wishlist/slv/items' && url.searchParams.get('lid') === listId;
    return url.protocol === 'https:' && ['amazon.com', 'www.amazon.com'].includes(url.hostname) && (listPage || cursorPage) ? url.toString() : null;
  } catch { return null; }
}

async function collectWith(loader: (url: string, timeout: number) => Promise<{ html: string; url: string; status?: number; contentType?: string | null }>, url: string, started: number, usedBrowser: boolean): Promise<CollectionResult> {
  const listId = url.split('/').pop()!, seen = new Set<string>(), items = new Map<string, SnapshotItem>();
  let current = url, pages = 0, name = '';
  while (true) {
    if (pages >= MAX_PAGES || items.size >= MAX_ITEMS) return failure('partial', 'Collection budget exceeded', pages, started, usedBrowser);
    const remaining = MAX_MS - (Date.now() - started);
    if (remaining <= 0) return failure('timeout', 'Collection timed out', pages, started, usedBrowser);
    let loaded;
    try { loaded = await loader(current, remaining); } catch (error) { return failure(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'parse_error', error instanceof Error ? error.message : 'Collection failed', pages, started, usedBrowser); }
    pages++;
    if (loaded.status === 404) return failure('not_found', 'Wishlist not found', pages, started, usedBrowser);
    if (loaded.status !== undefined && loaded.status !== 200) return failure('timeout', `Amazon returned HTTP ${loaded.status}`, pages, started, usedBrowser);
    if (loaded.contentType !== undefined && !loaded.contentType?.toLowerCase().includes('html')) return failure('timeout', 'Amazon returned a non-HTML response', pages, started, usedBrowser);
    let finalUrl: URL;
    try { finalUrl = new URL(loaded.url); } catch { return failure('parse_error', 'Invalid redirect URL', pages, started, usedBrowser); }
    if (finalUrl.protocol !== 'https:' || !['amazon.com', 'www.amazon.com'].includes(finalUrl.hostname)) return failure('parse_error', 'Wishlist redirected outside Amazon', pages, started, usedBrowser);
    if (finalUrl.pathname.startsWith('/ap/signin')) return failure('login_required', 'Wishlist requires login', pages, started, usedBrowser);
    const listPage = finalUrl.pathname.replace(/\/$/, '') === `/hz/wishlist/ls/${listId}`;
    const cursorPage = finalUrl.pathname === '/hz/wishlist/slv/items' && finalUrl.searchParams.get('lid') === listId;
    if (!listPage && !cursorPage) return failure('parse_error', 'Wishlist redirected to an unexpected page', pages, started, usedBrowser);
    const parsed = parseWishlistPage(loaded.html);
    name ||= parsed.name;
    if (parsed.state !== 'list') {
      const reason = parsed.state === 'login' ? 'login_required' : parsed.state === 'unknown' ? 'parse_error' : parsed.state;
      return failure(reason, reason === 'blocked' ? 'Amazon blocked collection' : reason === 'private' ? "This list is private or doesn't exist" : `Wishlist page was ${parsed.state}`, pages, started, usedBrowser);
    }
    if (parsed.foreignCurrency) return failure('currency', `Amazon showed prices in ${parsed.foreignCurrency}, not USD`, pages, started, usedBrowser);
    const previousCount = items.size;
    for (const item of parsed.items) if (items.size < MAX_ITEMS) items.set(item.entryId, item);
    if (items.size === previousCount || parsed.endOfList || !parsed.nextUrl)
      return { ok: true, url, name, items: [...items.values()], pages, complete: true, durationMs: Date.now() - started, usedBrowser };
    const next = nextPageUrl(parsed.nextUrl, listId);
    if (!next || seen.has(next)) return failure('partial', 'Pagination did not reach the end marker', pages, started, usedBrowser);
    seen.add(next); current = next;
  }
}

export async function collectWishlist(input: string, env: Env): Promise<CollectionResult> {
  const url = canonicalizeWishlistUrl(input), started = Date.now();
  if (!url) return failure('invalid_url', 'Use a shared Amazon US wishlist URL', 0, started, false);
  const fetched = await collectWith(async (pageUrl, timeout) => {
    const response = await fetch(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US', Cookie: 'i18n-prefs=USD; lc-main=en_US' }, signal: AbortSignal.timeout(Math.min(timeout, 20_000)) });
    return { html: await response.text(), url: response.url, status: response.status, contentType: response.headers.get('content-type') };
  }, url, started, false);
  if (fetched.ok || fetched.reason !== 'blocked') return fetched;

  let browser;
  try { browser = await puppeteer.launch(env.BROWSER); }
  catch (error) { return failure('parse_error', error instanceof Error ? error.message : 'Browser failed to start', fetched.pages, started, true); }
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US', Cookie: 'i18n-prefs=USD; lc-main=en_US' });
    return await collectWith(async (pageUrl, timeout) => {
      const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 20_000) });
      return { html: await page.content(), url: page.url(), status: response?.status() };
    }, url, started, true);
  } finally { await browser.close(); }
}
