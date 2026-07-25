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

  it('returns "Calculating..." when ETA exceeds 24 hours', () => {
    const eta = new EtaCalculator(10);
    // Very slow rate: 0.01% per 100000ms → remaining 99.99% would take ~999M ms (>24h)
    eta.addSample(100000, 0.01);
    const result = eta.estimateRemaining(0.01);
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
