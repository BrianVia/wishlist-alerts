import { describe, expect, it } from 'vitest';
import { decideAlert, looksSystematic } from '../src/watches';

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
