// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EtaCalculator } from './eta';

describe('EtaCalculator', () => {
  it('returns "Calculating..." initially (no samples)', () => {
    const eta = new EtaCalculator(10);
    expect(eta.estimateRemaining(50)).toBe('Calculating...');
  });

  it('returns "Done" when at 100%', () => {
    const eta = new EtaCalculator(10);
    expect(eta.estimateRemaining(100)).toBe('Done');
  });

  it('returns "Done" when above 100%', () => {
    const eta = new EtaCalculator(10);
    expect(eta.estimateRemaining(150)).toBe('Done');
  });

  it('computes ETA after adding samples', () => {
    const eta = new EtaCalculator(10);
    // Simulate 10% progress over 1000ms → rate = 0.01%/ms
    eta.addSample(1000, 10);
    const result = eta.estimateRemaining(50);
    expect(result).toBeTruthy();
    expect(result).not.toBe('Calculating...');
    expect(result).not.toBe('Done');
    expect(result).toContain('left');
  });

  it('reset clears the EMA rate', () => {
    const eta = new EtaCalculator(10);
    eta.addSample(1000, 10);
    eta.reset();
    expect(eta.estimateRemaining(50)).toBe('Calculating...');
  });

  it('handles zero elapsed time gracefully', () => {
    const eta = new EtaCalculator(10);
    // addSample with elapsedMs=0 should be ignored
    eta.addSample(0, 10);
    expect(eta.estimateRemaining(50)).toBe('Calculating...');
  });

  it('ignores invalid or non-positive samples', () => {
    const eta = new EtaCalculator(10);
    eta.addSample(1000, 10);
    expect(eta.estimateRemaining(50)).toBe('< 1m left');

    // A progress regression or non-finite sample must not poison the EMA.
    eta.addSample(1000, -100);
    eta.addSample(Number.NaN, 10);
    eta.addSample(1000, Number.POSITIVE_INFINITY);
    expect(eta.estimateRemaining(50)).toBe('< 1m left');
  });

  it('shows a real ETA for renders longer than 24 hours (up to 7 days)', () => {
    const eta = new EtaCalculator(10);
    // Slow rate: 0.04% per 100000ms → remaining 99.99% takes ~2.9 days.
    // That is beyond the old 24h cap (which hid the ETA for long renders)
    // but within the new 7-day display window, so it must render a real
    // duration instead of 'Calculating...'.
    eta.addSample(100000, 0.04);
    const result = eta.estimateRemaining(0.01);
    expect(result).toContain('left');
  });

  it('returns "Calculating..." only when ETA exceeds 7 days', () => {
    const eta = new EtaCalculator(10);
    // Extremely slow rate: remaining would take ~313 years — beyond the
    // 7-day sanity cap, so fall back to 'Calculating...'.
    eta.addSample(1_000_000_000, 0.01);
    const result = eta.estimateRemaining(1);
    expect(result).toBe('Calculating...');
  });

  it('EMA smooths over multiple samples', () => {
    const eta = new EtaCalculator(10);
    eta.addSample(1000, 10);
    const firstEta = eta.estimateRemaining(50);

    eta.addSample(500, 10); // faster rate
    const secondEta = eta.estimateRemaining(70);

    // Both should produce valid ETA strings
    expect(firstEta).toContain('left');
    expect(secondEta).toContain('left');
  });

  it('constructor accepts capacity parameter (backward compat)', () => {
    const eta = new EtaCalculator(5);
    eta.addSample(1000, 10);
    expect(eta.estimateRemaining(50)).toContain('left');
  });
});
