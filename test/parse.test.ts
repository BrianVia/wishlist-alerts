import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeWishlistUrl, collectWishlist, parseWishlistPage } from '../src/collect';
import blocked from './fixtures/blocked.html?raw';
import empty from './fixtures/empty.html?raw';
import login from './fixtures/login.html?raw';
import normal from './fixtures/normal.html?raw';
import paged from './fixtures/paged.html?raw';
import privatePage from './fixtures/private.html?raw';

afterEach(() => vi.unstubAllGlobals());

describe('Amazon wishlist parsing', () => {
  it('extracts exact item identity, money, and availability', () => {
    const page = parseWishlistPage(normal);
    expect(page).toMatchObject({ state: 'list', name: 'Birthday Ideas', endOfList: true, nextUrl: null });
    expect(page.items.map(item => [item.entryId, item.asin, item.priceCents, item.availability])).toEqual([
      ['e1', 'B012345678', 4999, 'priced'], ['e2', 'C012345678', 123456, 'priced'],
      ['e3', null, null, 'no_price'], ['e4', 'D012345678', null, 'unavailable'], ['e5', 'E012345678', 1025, 'priced'],
    ]);
    expect(page.items[0]).toMatchObject({ productUrl: 'https://www.amazon.com/dp/B012345678', byline: 'Acme' });
  });
  it('distinguishes empty, paged, blocked, and login pages', () => {
    expect(parseWishlistPage(empty)).toMatchObject({ state: 'list', items: [], endOfList: true });
    expect(parseWishlistPage(paged)).toMatchObject({ state: 'list', nextUrl: '/hz/wishlist/ls/ABC123?lek=next', endOfList: false });
    expect(parseWishlistPage(blocked).state).toBe('blocked');
    expect(parseWishlistPage(login).state).toBe('login');
    expect(parseWishlistPage(privatePage).state).toBe('private');
  });
  it('never fabricates dollars from a foreign-currency price', () => {
    const page = parseWishlistPage(normal.replace('$49.99', '€36,67'));
    expect(page.foreignCurrency).toBe('€');
    expect(page.items[0].priceCents).toBeNull();
  });
  it('treats $0.00 as no price', () => {
    expect(parseWishlistPage(normal.replace('$49.99', '$0.00')).items[0].priceCents).toBeNull();
  });
  it('canonicalizes only Amazon US shared-list URLs', () => {
    expect(canonicalizeWishlistUrl('https://amazon.com/hz/wishlist/ls/ABC123?ref=x#y')).toBe('https://www.amazon.com/hz/wishlist/ls/ABC123');
    expect(canonicalizeWishlistUrl('http://amazon.com/hz/wishlist/ls/ABC')).toBeNull();
    expect(canonicalizeWishlistUrl('https://evil.example/hz/wishlist/ls/ABC')).toBeNull();
  });
  it('finishes cursor pagination when a page contains no new entry IDs', async () => {
    const ids = (start: number) => Array.from({ length: 10 }, (_, index) => `entry-${start + index}`);
    const markup = (entryIds: string[], next: string) => `<div id="profile-list-name">Books</div><ul id="g-items">${entryIds.map((id, index) => `<li data-itemid="${id}"><a id="itemName_${id}" href="/dp/B00000000${index}">${id}</a><span class="a-price"><span class="a-offscreen">$10.00</span></span></li>`).join('')}</ul><input class="showMoreUrl" value="${next.replaceAll('&', '&amp;')}">`;
    const next1 = '/hz/wishlist/slv/items?lid=ABC123&page=2', next2 = '/hz/wishlist/slv/items?lid=ABC123&page=3', next3 = '/hz/wishlist/slv/items?lid=ABC123&page=4';
    const pages = [markup(ids(0), next1), markup(ids(10), next2), markup(ids(10), next3)];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const response = new Response(pages[call++], { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: String(input) });
      return response;
    }));
    const result = await collectWishlist('https://www.amazon.com/hz/wishlist/ls/ABC123', {} as Env);
    expect(result).toMatchObject({ ok: true, pages: 3, name: 'Books' });
    if (result.ok) expect(result.items).toHaveLength(20);
  });
});
