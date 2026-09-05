// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseLevel, type LogLevel } from './logLevels';

/**
 * Unit tests for the shared log-level parser.
 *
 * parseLevel is the single source of truth that both `LogLine.tsx` (colour)
 * and `LogViewer.tsx` (filter chips) depend on.  The test suite below
 * documents the contract in code so future contributors don't have to
 * reason about the regex from the header comment alone.
 */
describe('parseLevel', () => {
  describe('bracketed prefixes', () => {
    it.each([
      ['[INFO] Application starting', 'INFO'],
      ['[INFO] user clicked button', 'INFO'],
      ['[WARN] slow disk operation', 'WARN'],
      ['[WARN] retrying connection', 'WARN'],
      ['[ERROR] disk write failed', 'ERROR'],
      // Constitutional rule from logLevels.ts header: [FATAL] collapses to ERROR.
      ['[FATAL] kernel panic', 'ERROR'],
      ['[SUCCESS] render complete', 'SUCCESS'],
    ])('classifies %s as %s', (input, expected) => {
      expect(parseLevel(input)).toBe(expected);
    });
  });

  describe('bare FATAL/ERROR prefix', () => {
    // The regex is anchored at start-of-string and case-insensitive.
    it.each([
      ['FATAL: out of memory', 'ERROR'],
      ['ERROR: connection refused', 'ERROR'],
      ['fatal: hardware failure', 'ERROR'],
      ['error: timeout', 'ERROR'],
      ['Fatal: capitalised', 'ERROR'],
      ['Error: capitalised', 'ERROR'],
      // NOT anchored to start of line — bare prefix may follow arbitrary text.
      // (Bare prefix is only ACTUALLY anchored; this case should return null.)
      ['leading text FATAL: embedded', null],
      ['middle: FATAL: not at start', null],
    ])('classifies bare prefix in %s', (input, expected) => {
      expect(parseLevel(input)).toBe(expected);
    });
  });

  describe('null for unrecognized text', () => {
    it.each([
      ['just a line of console output'],
      [''],
      ['plain text no prefix'],
      ['contains the word "fatal" but not as prefix'],
      ['non-fatal issue detected'],
      ['warning zone lies ahead'],
      ['info@somewhere.com'],
      ['SUCCESS without brackets'],
    ])('returns null for %s', (input) => {
      expect(parseLevel(input)).toBeNull();
    });
  });

  describe('precedence (order of checks)', () => {
    // parseLevel's if-chain order is: SUCCESS → ERROR/FATAL/bare → WARN → INFO.
    // These tests pin that order down so a future reorder of branches
    // cannot silently change observable behaviour.
    it('SUCCESS wins over ERROR when both brackets present', () => {
      expect(parseLevel('[SUCCESS] [ERROR] benchmark ok')).toBe('SUCCESS');
    });

    it('ERROR bracket wins over WARN bracket when both present', () => {
      expect(parseLevel('[ERROR] [WARN] disk full')).toBe('ERROR');
    });

    it('WARN bracket wins over INFO bracket when both present', () => {
      expect(parseLevel('[WARN] [INFO] slow path')).toBe('WARN');
    });

    it('bare ERROR: wins over [INFO] in same line', () => {
      expect(parseLevel('ERROR: includes [INFO] tag too')).toBe('ERROR');
    });

    it('bare FATAL: wins over [INFO] in same line', () => {
      expect(parseLevel('FATAL: [INFO] kill')).toBe('ERROR');
    });
  });

  describe('return-type contract', () => {
    // Catches accidental widening/narrowing of the return type to e.g.
    // untyped strings or additional level variants.
    it('result is one of INFO | WARN | ERROR | SUCCESS | null', () => {
      const validLevels: Array<LogLevel | null> = [
        'INFO',
        'WARN',
        'ERROR',
        'SUCCESS',
        null,
      ];
      const sampleInputs = [
        '[INFO] x',
        '[WARN] x',
        '[ERROR] x',
        '[SUCCESS] x',
        'FATAL: x',
        'plain text',
        '',
      ];
      for (const input of sampleInputs) {
        expect(validLevels).toContain(parseLevel(input));
      }
    });
  });
});
