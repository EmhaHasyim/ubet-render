// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { coerceFromRecord, defaultConfigRecord } from './schema';

describe('defaultConfigRecord', () => {
  it('returns the canonical defaults', () => {
    const defaults = defaultConfigRecord();
    expect(defaults.outputPrefix).toBe('Ubet Render');
    expect(defaults.maxrate).toBe('4000k');
    expect(defaults.codec).toBe('av1');
    expect(defaults.audioMode).toBe('original');
    expect(defaults.outputFormat).toBe('mp4');
    expect(defaults.loopMode).toBe('duration');
    expect(defaults.skipIntermediateOnCodecMatch).toBe(false);
  });
});

describe('coerceFromRecord', () => {
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
    expect(coerceFromRecord({ songsPerPlaylist: 1000 }).songsPerPlaylist).toBe(
      100,
    );
    expect(coerceFromRecord({ minDurationHours: 0.01 }).minDurationHours).toBe(
      0.1,
    );
    expect(coerceFromRecord({ loopCount: 3.7 }).loopCount).toBe(4);
  });

  it('preserves valid values', () => {
    const coerced = coerceFromRecord({
      videoSource: { type: 'files', paths: ['a.mp4'] },
      maxrate: '8000k',
      codec: 'h265',
      loopCount: 3,
    });
    expect(coerced.videoSource).toEqual({ type: 'files', paths: ['a.mp4'] });
    expect(coerced.maxrate).toBe('8000k');
    expect(coerced.codec).toBe('h265');
    expect(coerced.loopCount).toBe(3);
  });
});
