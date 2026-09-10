# Wishlist Alerts — App and API Review

Reviewed September 10, 2026.

## Recommendation

The strongest product bet is to turn this into **“what should I buy from my wishlist this week?”** A budget-aware shortlist could be much more useful than individual price-drop notifications.

The foundation is sensible: six backend files, 582 lines, and one framework-free dashboard. All **18 tests and the typecheck passed** during this review. The review covered code and fixtures; it did not verify the deployed app or live email delivery.

Wishlist imports, price histories, and alerts already exist in [camelcamelcamel](https://camelcamelcamel.com/tools) and [Keepa](https://keepa.com/). No feature here is proven unbeatable, but there is room to make the decision experience substantially better.

## 1. Potential 10× feature: “Buy next,” with a budget

For the roughly 500-item book list documented in this project, let the user say:

> I have $60 this month. Prioritize these ten books. Show me unusually good prices.

Then produce a short, explained recommendation. Illustrative output:

> These three books total $47. Two are at their lowest observed price in 90 days. The third reached your target. Nothing else on your priority list looks exceptional.

The important ingredients:

- **Priorities:** must-have, interested, someday.
- **Price context:** how unusual today’s price is within the period actually observed.
- **A spending limit:** permission to recommend buying nothing.
- **Feedback:** bought, snooze, no longer interested.

Start with deterministic ranking and one digest. No AI model is necessary. Later, preference and purchase feedback could make it increasingly personal. That accumulated understanding is a more plausible advantage than another price chart.

Measure **recommendations marked useful and purchases within budget**, rather than just email opens.

## 2. Smarter alerts, including the second, better deal

Today, the first observed price determines the percentage discount forever. Importing the same item on different days can produce very different alerts.

Keep that baseline, but add observed-history context. Illustrative output:

> $18 today. First seen at $30. Usually observed around $22. Lowest observed: $17.

History is stored **only when values change**. Historical averages or percentiles should account for time at each price and gaps in collection; averaging stored rows would overrepresent volatile periods. Claims must reflect actual observation coverage.

There is also a valuable missing alert: **a substantial further drop while an alert is already active**. In the current policy, $100 → $79 alerts, but $79 → $40 stays silent until the condition first recovers. Offer an opt-in rule for a meaningful improvement since the last notification, with a cooldown.

## 3. Book-specific expansion: acceptable editions

The actual intent might be “read this book,” while the watch follows one Amazon listing.

Let someone explicitly group acceptable editions or formats:

> Paperback or hardcover is fine; notify me when either falls below $15.

This could uncover savings the current ASIN-specific watch misses. Start with manually linked alternatives. Automatic edition matching, used condition, shipping, and other sellers introduce real data-quality work; validate demand before building those.

## Reliability fixes before larger features

These findings are based on code inspection. The existing passing suite does not establish that the failure and concurrency scenarios below are handled correctly.

| Priority | Finding | Improvement |
| --- | --- | --- |
| High | In [`src/notify.ts`](src/notify.ts), email failures return normally, leaving delivery `pending`, while [`src/workflow.ts`](src/workflow.ts) treats the step as complete. Most collection failures have the same retry mismatch. | Make retryable failures trigger the configured Workflow retries; preserve terminal failures. The existing test manually calls delivery twice, so it misses this integration bug. See [Cloudflare retry behavior](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/). |
| High | In [`src/watches.ts`](src/watches.ts), large checks stage observations into the live history table, but dashboard/history queries do not require a successfully recorded run. A crash before final commit can expose partial results. | Publish observations only from completed runs, consistently across dashboard, history, and alert comparisons. |
| High | In [`src/watches.ts`](src/watches.ts), stale-run protection happens before subsequent reads and writes. Overlapping runs can both pass that check and evaluate the same old alert state. | Enforce one active check per wishlist or make commit conditional on a durable version. Add an actual interleaving test. |
| Medium | In [`src/watches.ts`](src/watches.ts), the systematic-price guard compares against the original baseline, despite describing a simultaneous price movement. Legitimate similar discounts can repeatedly reject a list. | Compare with previous observations and confirm suspicious snapshots. Preserve currency protection while testing legitimate coordinated sales. |

## Dashboard and API improvements

In [`public/index.html`](public/index.html), every list’s full contents load sequentially, even with its items collapsed. Load summaries first and items on expansion.

Add search, sorting by savings, and a **“deals now”** view. Expose the percentage threshold already supported by the API.

For manual checks, expose an owner-scoped run-status endpoint and poll until completion. The current single refresh after ten seconds can miss a collection that takes minutes. Show delivery failures too: the API already returns deliveries, but the dashboard ignores them.

## Architecture and protected behavior

Retain the existing owners:

| Module | Responsibility |
| --- | --- |
| [`src/collect.ts`](src/collect.ts) | Extract and validate collection snapshots. |
| [`src/watches.ts`](src/watches.ts) | Own persistence, watch settings, and alert transitions. |
| [`src/notify.ts`](src/notify.ts) | Own delivery and its durable outcome. |
| [`src/identity.ts`](src/identity.ts) | Resolve verified user identity. |
| [`src/index.ts`](src/index.ts), [`src/workflow.ts`](src/workflow.ts) | Adapt HTTP, scheduling, and Workflow execution to those operations. |

Consolidate duplicated import/check persistence rules inside this structure. There is no demonstrated need for more services or a generic repository layer.

Preserve ownership checks, integer cents, original baselines, missing-price behavior, history, and bounded delivery attempts. No files or supported features are proven safe to delete or approved for retirement by this review.

Requirements worth revisiting explicitly:

- Keep the original baseline, but make richer historical context an additional feature.
- Preserve existing transition suppression by default; make further-drop alerts opt-in.
- Keep currency protection while correcting the systematic-shift heuristic.
- Defer shared product history until overlapping watches justify the migration.
- Defer automatic edition matching and AI until the simpler product proves useful.

## Implementation order and validation

1. **Fix retries and publication/concurrency safety.** Add Workflow failure tests, interrupted-batch tests, and overlapping-run tests. Preserve bounded retries and the documented possibility of a duplicate email after provider acceptance but before recording success.
2. **Ship the ranked deals view and better alert context.** Preserve existing API and ownership behavior. Compare old and new persistence paths for baseline, history, and alert parity where behavior is intended to remain unchanged. Measure loading and query timings on the actual list size.
3. **Test the budget-aware shortlist.** Start with priorities, a budget, a deterministic ranking, and useful/not-useful feedback. Evaluate usefulness before expanding to automatic edition matching or additional data sources.

Validation completed for this review: `npm test` (18 passed) and `npm run typecheck` (passed). No application code was changed as part of the review. Live collection, deployed UI behavior, and inbox delivery remain unverified by this review.
