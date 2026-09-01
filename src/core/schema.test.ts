// Golden contract test: the single-source config schema must match the
// checked-in contract file that the Rust side cross-checks against
// `OverrideConfig` (see src-tauri/src/validation.rs sentinel test).
import { describe, it, expect } from 'vitest';
import {
  CONFIG_SCHEMA,
  CONFIG_FIELD_NAMES,
  coerceFromRecord,
  defaultConfigRecord,
  coerceField,
} from './schema';

// The contract file is read via Vite's raw import so the test stays
// isomorphic (no node typings needed in the browser-oriented tsconfig).
import contractJson from './config-contract.json';

const contract = contractJson as {
  fields: { name: string; kind: string; default: unknown }[];
  version: number;
};

describe('config schema contract', () => {
  it('field list matches the checked-in contract file', () => {
    expect(contract.fields.map((f) => f.name)).toEqual([...CONFIG_FIELD_NAMES]);
    expect(contract.version).toBe(3);
  });

  it('contract defaults match schema defaults', () => {
    for (const f of contract.fields) {
      const desc = CONFIG_SCHEMA.find((d) => d.name === f.name);
      expect(desc, `schema missing field ${f.name}`).toBeDefined();
      expect(desc!.default, `default drift on ${f.name}`).toEqual(f.default);
    }
  });

  it('schema defaults are the canonical defaults', () => {
    const defaults = defaultConfigRecord();
    expect(defaults.outputPrefix).toBe('Ubet Render');
    expect(defaults.maxrate).toBe('4000k');
    expect(defaults.codec).toBe('av1');
    expect(defaults.audioMode).toBe('original');
    expect(defaults.outputFormat).toBe('mp4');
    expect(defaults.loopMode).toBe('duration');
    expect(defaults.skipIntermediateOnCodecMatch).toBe(false);
  });

  it('coerces wrong-typed fields to defaults', () => {
    const coerced = coerceFromRecord({
      videoSource: 'garbage',
      outputPath: 42,
      maxrate: null,
      usePingpong: 'yes',
      songsPerPlaylist: -5,
      minDurationHours: 999,
      loopCount: 0,
      codec: 'mpeg2',
      audioMode: 'louder',
      outputFormat: 'avi',
      loopMode: 'both',
    });
    expect(coerced.videoSource).toBeNull();
    expect(coerced.outputPath).toBe('');
    expect(coerced.maxrate).toBe('4000k');
    expect(coerced.usePingpong).toBe(true);
    expect(coerced.songsPerPlaylist).toBe(1);
    expect(coerced.minDurationHours).toBe(24);
    expect(coerced.loopCount).toBe(1);
    expect(coerced.codec).toBe('av1');
    expect(coerced.audioMode).toBe('original');
    expect(coerced.outputFormat).toBe('mp4');
    expect(coerced.loopMode).toBe('duration');
  });

  it('clamps numeric fields into the backend validation ranges', () => {
    expect(
      coerceField(
        CONFIG_SCHEMA.find((f) => f.name === 'songsPerPlaylist')!,
        1000,
      ),
    ).toBe(100);
    expect(
      coerceField(
        CONFIG_SCHEMA.find((f) => f.name === 'minDurationHours')!,
        0.01,
      ),
    ).toBe(0.1);
    expect(
      coerceField(CONFIG_SCHEMA.find((f) => f.name === 'loopCount')!, 3.7),
    ).toBe(4);
  });
});
