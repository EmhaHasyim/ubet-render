// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildAppConfig } from './buildAppConfig';
import { DEFAULT_CONFIG } from './config';
import type { AppConfig } from './types';

function makeState(overrides?: Partial<Record<string, unknown>>) {
  const state = {
    outputPath: () => (overrides?.outputPath as string) ?? '',
    outputPrefix: () => (overrides?.outputPrefix as string) ?? '',
    minDurationHours: () => (overrides?.minDurationHours as number) ?? 1,
    maxrate: () => (overrides?.maxrate as string) ?? '4000k',
    codec: () => (overrides?.codec as string) ?? 'av1',
    songsPerPlaylist: () => (overrides?.songsPerPlaylist as number) ?? 9,
    audioMode: () =>
      (overrides?.audioMode as 'original' | 'normalize') ?? 'original',
    embedChapters: () => (overrides?.embedChapters as boolean) ?? true,
  };
  return state;
}

const mockEncoder = (codec: string) => `enc_${codec}`;

describe('buildAppConfig', () => {
  it('uses default directory values', () => {
    const cfg = buildAppConfig(makeState(), mockEncoder);
    expect(cfg.directories.video).toBe(DEFAULT_CONFIG.directories.video);
    expect(cfg.directories.audio).toBe(DEFAULT_CONFIG.directories.audio);
    expect(cfg.directories.cache).toBe(DEFAULT_CONFIG.directories.cache);
  });

  it('uses outputPath when provided, falls back to default', () => {
    const withPath = buildAppConfig(
      makeState({ outputPath: '/custom/output' }),
      mockEncoder,
    );
    expect(withPath.directories.output).toBe('/custom/output');

    const withoutPath = buildAppConfig(
      makeState({ outputPath: '' }),
      mockEncoder,
    );
    expect(withoutPath.directories.output).toBe(
      DEFAULT_CONFIG.directories.output,
    );
  });

  it('uses outputPrefix when provided, falls back to default', () => {
    const withPrefix = buildAppConfig(
      makeState({ outputPrefix: 'My Channel' }),
      mockEncoder,
    );
    expect(withPrefix.metadata.channelPrefix).toBe('My Channel');

    const withoutPrefix = buildAppConfig(
      makeState({ outputPrefix: '' }),
      mockEncoder,
    );
    expect(withoutPrefix.metadata.channelPrefix).toBe(
      DEFAULT_CONFIG.metadata.channelPrefix,
    );
  });

  it('calculates minDurationSec in seconds', () => {
    const cfg = buildAppConfig(makeState({ minDurationHours: 2 }), mockEncoder);
    expect(cfg.target.minDurationSec).toBe(7200);
  });

  it('minDurationHours falls back to 1 when 0', () => {
    const cfg = buildAppConfig(makeState({ minDurationHours: 0 }), mockEncoder);
    expect(cfg.target.minDurationSec).toBe(3600);
  });

  it('uses paddingSec from defaults', () => {
    const cfg = buildAppConfig(makeState(), mockEncoder);
    expect(cfg.target.paddingSec).toBe(DEFAULT_CONFIG.target.paddingSec);
  });

  it('uses maxrate for both bitrateTarget and bitrateMax, falls back to defaults', () => {
    const withRate = buildAppConfig(
      makeState({ maxrate: '8000k' }),
      mockEncoder,
    );
    expect(withRate.video.bitrateTarget).toBe('8000k');
    expect(withRate.video.bitrateMax).toBe('8000k');

    const withoutRate = buildAppConfig(makeState({ maxrate: '' }), mockEncoder);
    expect(withoutRate.video.bitrateTarget).toBe(
      DEFAULT_CONFIG.video.bitrateTarget,
    );
    expect(withoutRate.video.bitrateMax).toBe(DEFAULT_CONFIG.video.bitrateMax);
  });

  it('calls resolveEncoder with codec value', () => {
    let calledWith = '';
    const tracker = (c: string) => {
      calledWith = c;
      return `enc_${c}`;
    };
    const cfg = buildAppConfig(makeState({ codec: 'h265' }), tracker);
    expect(calledWith).toBe('h265');
    expect(cfg.video.encoder).toBe('enc_h265');
  });

  it('uses default preset', () => {
    const cfg = buildAppConfig(makeState(), mockEncoder);
    expect(cfg.video.preset).toBe(DEFAULT_CONFIG.video.preset);
  });

  it('songsPerPlaylist falls back to default when 0', () => {
    const cfg = buildAppConfig(makeState({ songsPerPlaylist: 0 }), mockEncoder);
    expect(cfg.audio.songsPerPlaylist).toBe(
      DEFAULT_CONFIG.audio.songsPerPlaylist,
    );
  });

  it('uses default audio settings for concurrentPrep, bitrate, sampleRate, loudnorm', () => {
    const cfg = buildAppConfig(makeState(), mockEncoder);
    expect(cfg.audio.concurrentPrep).toBe(DEFAULT_CONFIG.audio.concurrentPrep);
    expect(cfg.audio.bitrate).toBe(DEFAULT_CONFIG.audio.bitrate);
    expect(cfg.audio.sampleRate).toBe(DEFAULT_CONFIG.audio.sampleRate);
    expect(cfg.audio.loudnormParams).toBe(DEFAULT_CONFIG.audio.loudnormParams);
  });

  it('passes audioMode through directly', () => {
    const original = buildAppConfig(
      makeState({ audioMode: 'original' }),
      mockEncoder,
    );
    expect(original.audio.audioMode).toBe('original');

    const normalize = buildAppConfig(
      makeState({ audioMode: 'normalize' }),
      mockEncoder,
    );
    expect(normalize.audio.audioMode).toBe('normalize');
  });

  it('passes embedChapters through', () => {
    const truthy = buildAppConfig(
      makeState({ embedChapters: true }),
      mockEncoder,
    );
    expect(truthy.embedChapters).toBe(true);

    const falsy = buildAppConfig(
      makeState({ embedChapters: false }),
      mockEncoder,
    );
    expect(falsy.embedChapters).toBe(false);
  });

  it('returns a complete AppConfig with all keys', () => {
    const cfg = buildAppConfig(makeState(), mockEncoder);
    const expectedKeys: (keyof AppConfig)[] = [
      'directories',
      'metadata',
      'target',
      'video',
      'audio',
      'embedChapters',
    ];
    for (const key of expectedKeys) {
      expect(cfg).toHaveProperty(key);
    }
  });
});
