import { describe, expect, it } from 'vitest';
import { decideAlert, looksSystematic, priceContext } from '../src/watches';

const decide = (priceCents: number | null, overrides: Partial<Parameters<typeof decideAlert>[0]> = {}) => decideAlert({ priceCents, baselineCents: 10_000, targetCents: null, pctThreshold: 20, alertActive: false, ...overrides });
describe('alert transition policy', () => {
  it('uses strict integer percentage math', () => {
    expect(decide(8000).qualifies).toBe(false);
    expect(decide(7999)).toMatchObject({ qualifies: true, kind: 'pct', nextAlertActive: true });
  });
  it('handles target, suppression, recovery, missing price, and zero baseline', () => {
    expect(decide(9000, { targetCents: 9000 })).toMatchObject({ qualifies: true, kind: 'target' });
    expect(decide(7000, { targetCents: 7500 })).toMatchObject({ kind: 'both' });
    expect(decide(7000, { alertActive: true })).toMatchObject({ qualifies: true, nextAlertActive: true });
    expect(decide(9000, { alertActive: true })).toMatchObject({ qualifies: false, nextAlertActive: false });
    expect(decide(null, { alertActive: true })).toMatchObject({ qualifies: false, nextAlertActive: true });
    expect(decide(0, { baselineCents: 0, alertActive: true })).toMatchObject({ qualifies: false, nextAlertActive: true });
  });
  it('only repeats an active alert after the configured further drop', () => {
    expect(decide(7900)).toMatchObject({ qualifies: true, kind: 'pct' });
    expect(decide(7000, { alertActive: true, lastAlertCents: 7900, redropPct: 20 }).kind).not.toBe('redrop');
    expect(decide(4000, { alertActive: true, lastAlertCents: 7900, redropPct: 20 })).toMatchObject({ qualifies: true, kind: 'redrop' });
    expect(decide(4000, { alertActive: true, lastAlertCents: 7900, redropPct: null }).kind).not.toBe('redrop');
  });
});

describe('price context', () => {
  const at = (day: number, price_cents: number | null) => ({ observed_at: new Date(Date.UTC(2026, 0, day + 1)).toISOString(), price_cents });
  it('weights prices by time and reports honest coverage', () => {
    expect(priceContext([at(0, 1000)], at(10, 0).observed_at)).toEqual({ typicalCents: 1000, lowestCents: 1000, daysObserved: 10, coverage: 'thin' });
    expect(priceContext([at(0, 1000), at(29, 2000), at(30, 1000)], at(31, 0).observed_at)).toMatchObject({ typicalCents: 1000, lowestCents: 1000, daysObserved: 31, coverage: 'ok' });
    expect(priceContext([at(0, 1000), at(10, null), at(20, 2000)], at(30, 0).observed_at)).toMatchObject({ typicalCents: 1000, daysObserved: 20, coverage: 'ok' });
  });
});

describe('systematic-shift guard', () => {
  const pair = (previous: number, price: number) => ({ previousCents: previous, priceCents: price });
  it('rejects a run where most items moved by one identical ratio', () => {
    const shifted = Array.from({ length: 20 }, (_, i) => pair(1000 + i * 137, Math.round((1000 + i * 137) * 0.73)));
    expect(looksSystematic(shifted)).toMatch(/of 20 priced items moved to 73%/);
    expect(looksSystematic(shifted.map(({ priceCents }) => pair(priceCents, priceCents)))).toBeNull();
  });
  it('accepts genuine scattered changes and unchanged lists', () => {
    const scattered = Array.from({ length: 20 }, (_, i) => pair(1000, i < 5 ? 700 + i * 50 : 1000));
    expect(looksSystematic(scattered)).toBeNull();
    expect(looksSystematic(Array.from({ length: 20 }, () => pair(1000, 1000)))).toBeNull();
    expect(looksSystematic([pair(1000, 730), pair(2000, 1460)])).toBeNull();
  });
});
