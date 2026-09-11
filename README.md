# Wishlist Alerts

Watch your Amazon wishlists and get one email when something is actually on sale.

Paste a shared Amazon US wishlist link. The app records every item's price daily (or hourly), remembers the first price it saw, and emails you when an item drops more than 20% below that, or hits a target price you set. It emails once per drop, stays quiet while the price stays low, and re-arms when the price recovers.

It runs entirely on Cloudflare: one Worker, one D1 database, Workflows for the checks, Email Service for the mail. No servers, no browser farm. A 500-item list costs about a minute of fetch time a day and fits easily in the $5/month Workers plan.

This is a personal tool. It is not affiliated with Amazon, and scraping Amazon pages is against their terms of use. Run it on your own account, for your own lists.

## Screenshot
<img width="1273" height="1296" alt="image" src="https://github.com/user-attachments/assets/5d108af0-5c8b-4e31-bb1e-8eb8e71bb0f0" />


## What you get

- Import any shared Amazon US wishlist by URL. New items are picked up on later checks.
- A "Current deals" strip at the top: every item below its first-seen price, across all lists, biggest drop first.
- Current, first-seen, and lowest price per item, with history.
- Daily or hourly checks, pause/resume, "check now".
- Per-item target price and percent threshold, per-item on/off.
- One batched email per check listing everything that qualified.
- Honest health: each list shows ok, stale, private, blocked, or the last error. A failed check never touches your prices.
- Sanity guards: prices in a non-USD currency, or a whole list shifting by one identical ratio, fail the check instead of firing alerts.

A coordinated price shift is rejected as suspect. If it is a legitimate storewide sale, the list can be re-run manually.

## Quick start (local)

Needs Node 24 and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars   # sets DEV_USER_EMAIL, your local identity
npm run migrate:local
npm run dev                      # http://localhost:8787
```

Paste a wishlist URL on the page. Locally, emails are written to `.wrangler/tmp/email/` instead of sent.

Checks:

```sh
npm run typecheck
npm test
```

## Deploy to your Cloudflare account

1. Create the database and put its ID in `wrangler.jsonc` (`database_id`):

   ```sh
   npx wrangler d1 create wishlist-alerts
   npm run migrate:remote
   ```

2. Set `EMAIL_FROM` in `wrangler.jsonc` to an address on a domain you have verified for [Email Service](https://developers.cloudflare.com/email-service/). Until then, the dashboard is your alert.

3. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) in front of the Worker, allowing only your email. Copy the application's audience tag and your team slug into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. The Worker verifies the Access JWT on every API call. While `ACCESS_TEAM_DOMAIN` is empty the Worker only accepts `DEV_USER_EMAIL` from `.dev.vars`, so a deploy without Access configured rejects every request.

4. Deploy:

   ```sh
   npm run deploy
   ```

   To keep your real IDs out of git, copy `wrangler.jsonc` to `wrangler.local.jsonc` (ignored) and use `npm run deploy:local-config`.

The cron runs hourly (UTC) and starts a Workflow for each list that is due. Run `npx wrangler types` after changing bindings.

### Bindings

| Name | Type | Purpose |
|---|---|---|
| `DB` | D1 | all state |
| `CHECK_WORKFLOW` | Workflow `CheckWorkflow` | collect, record, deliver as retryable steps |
| `EMAIL` | Email Service | outbound mail |
| `BROWSER` | Browser Run | fallback only when plain fetch is blocked |
| `ASSETS` | static assets | the dashboard in `public/` |

## How it works

```
cron (hourly) ──▶ due lists ──▶ CheckWorkflow
                                  ├─ collect   fetch list pages, parse, validate
                                  ├─ record    one D1 batch: observations, baselines, alert decisions, run status
                                  └─ deliver   one email for the run's alerts
```

**Collection** (`src/collect.ts`) fetches the list page and follows Amazon's server-side "show more" cursor, 10 items a page. There is no end marker; the loop stops when a page yields no new item IDs, capped at 150 pages, 1,500 items, and 3 minutes. Prices must be `$` USD; anything else fails the run. CAPTCHA, login walls, private lists, timeouts, and partial pagination are all explicit failures, never silent success.

**Watches** (`src/watches.ts`) owns the database and the alert rule. The rule, `decideAlert`, is pure and unit-tested:

- baseline = first valid price ever seen, never reset
- percent match = `price * 100 < baseline * (100 - threshold)`, strictly below, so exactly 20% off does not fire at 20
- target match = `price <= target`
- fire once when a match appears, suppress while it persists, re-arm on a valid price that no longer matches
- a missing price changes nothing

Every user-facing query is scoped by owner in SQL. Two users cannot see or touch each other's lists even if they share the same Amazon wishlist.

**Notifications** (`src/notify.ts`) claims the run's pending delivery, builds one HTML+text email with every alert, and records the provider message ID. Two attempts max. A crash between provider acceptance and the `sent` write can produce a duplicate; we prefer that to a lost alert.

**Identity** (`src/identity.ts`) verifies the Cloudflare Access JWT against the team's JWKS and upserts a user row. Users are keyed by an internal UUID, never by a hardcoded ID.

## Data

Seven tables in `migrations/0001_init.sql`: `users`, `wishlists`, `items`, `runs`, `observations`, `alerts`, `deliveries`.

- Money is integer cents with an explicit currency column. A missing price is `NULL`, never `0`.
- `observations` is write-on-change: a row is written only when price or availability differs from the item's last row. `items.last_seen_at` carries freshness. A 500-item list checked daily grows by a few hundred rows a month, not 15,000.
- Unique keys prevent duplicate list membership, duplicate observations per run, and duplicate alerts per run and item. Re-running a check is safe.

## API

All routes require identity. Bodies are JSON. IDs come from the route, never the body.

| Method | Path | Body |
|---|---|---|
| GET | `/api/me` | |
| GET | `/api/wishlists` | |
| GET | `/api/deals` | items currently below their first-seen price, across all lists |
| GET | `/api/runs/:id` | owner-scoped check status |
| POST | `/api/wishlists` | `{url, frequency?: "daily"\|"hourly", addNewItems?}` |
| GET | `/api/wishlists/:id` | |
| PATCH | `/api/wishlists/:id` | `{monitored?, frequency?, addNewItems?, name?}` |
| POST | `/api/wishlists/:id/check` | (max one per 5 minutes) |
| PATCH | `/api/items/:id` | `{monitored?, targetCents?: number\|null, pctThreshold?: 1..99}` |
| GET | `/api/items/:id/history` | |
| POST | `/api/test-email` | sends to the caller only |

## Known limits

- Amazon US, shared lists only. Private lists show as private.
- The parser is tied to Amazon's current markup. When they change it, `test/fixtures/` is where to start.
- No signup, billing, or multi-store. This is deliberately a one-person tool.
- Amazon localizes prices by the requesting server's location. The collector asks for USD and rejects anything else, but if you see a whole list "on sale" by one identical percent, that guard is what should have caught it.

## License

MIT.
