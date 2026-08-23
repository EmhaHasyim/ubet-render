import { describe, it, expect } from 'vitest';
import { isMaxrateValid, normalizeBitrate, formatDuration } from './estimate';

describe('isMaxrateValid', () => {
  it('accepts an integer bitrate with k suffix', () => {
    expect(isMaxrateValid('4000k')).toBe(true);
    expect(isMaxrateValid(' 4000k ')).toBe(true);
    expect(isMaxrateValid('4000K')).toBe(true);
  });

  it('accepts an integer bitrate without k suffix', () => {
    expect(isMaxrateValid('4000')).toBe(true);
    expect(isMaxrateValid(' 4000 ')).toBe(true);
    expect(isMaxrateValid('5000')).toBe(true);
  });

  it('rejects decimals, fractional, or non-numeric values', () => {
    expect(isMaxrateValid('0.5k')).toBe(false);
    expect(isMaxrateValid('0.5')).toBe(false);
    expect(isMaxrateValid('k4000')).toBe(false);
    expect(isMaxrateValid('4000kb')).toBe(false);
    expect(isMaxrateValid('')).toBe(false);
    expect(isMaxrateValid('abc')).toBe(false);
  });

  it('accepts values at the range boundaries', () => {
    expect(isMaxrateValid('100k')).toBe(true);
    expect(isMaxrateValid('100')).toBe(true);
    expect(isMaxrateValid('50000k')).toBe(true);
    expect(isMaxrateValid('50000')).toBe(true);
  });

  it('rejects values below the minimum range', () => {
    expect(isMaxrateValid('99k')).toBe(false);
    expect(isMaxrateValid('99')).toBe(false);
    expect(isMaxrateValid('50k')).toBe(false);
    expect(isMaxrateValid('0k')).toBe(false);
    expect(isMaxrateValid('0')).toBe(false);
  });

  it('rejects values above the maximum range', () => {
    expect(isMaxrateValid('50001k')).toBe(false);
    expect(isMaxrateValid('50001')).toBe(false);
    expect(isMaxrateValid('99999k')).toBe(false);
  });
});

describe('normalizeBitrate', () => {
  it('appends k suffix when missing', () => {
    expect(normalizeBitrate('5000')).toBe('5000k');
    expect(normalizeBitrate('1234')).toBe('1234k');
  });

  it('keeps existing k suffix', () => {
    expect(normalizeBitrate('5000k')).toBe('5000k');
    expect(normalizeBitrate('5000K')).toBe('5000k');
  });

  it('strips invalid suffixes but keeps valid number', () => {
    expect(normalizeBitrate('5000kb')).toBe('5000k');
  });

  it('trims whitespace', () => {
    expect(normalizeBitrate(' 5000 ')).toBe('5000k');
  });

  it('returns unchanged for completely invalid input', () => {
    expect(normalizeBitrate('abc')).toBe('abc');
    expect(normalizeBitrate('')).toBe('');
    expect(normalizeBitrate('k5000')).toBe('k5000');
    expect(normalizeBitrate('0.5')).toBe('0.5');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations as "< 1m"', () => {
    expect(formatDuration(5000)).toBe('< 1m left');
    expect(formatDuration(59000)).toBe('< 1m left');
  });

  it('formats minutes only (no seconds noise)', () => {
    expect(formatDuration(60000)).toBe('1m left');
    expect(formatDuration(65000)).toBe('1m left');
  });

  it('formats hours and minutes (no seconds noise)', () => {
    expect(formatDuration(3660000)).toBe('1h 1m left');
    expect(formatDuration(3661000)).toBe('1h 1m left');
  });

  it('returns empty string for non-positive or invalid input', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-1000)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});
