import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDefaultInitial,
  loadPersistedConfig,
  STORAGE_KEY,
  STORAGE_VERSION,
} from './persisted';
import { DEFAULT_CONFIG } from './config';

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// getDefaultInitial
// ---------------------------------------------------------------------------
describe('getDefaultInitial', () => {
  it('returns a config with the current version', () => {
    const cfg = getDefaultInitial();
    expect(cfg.version).toBe(STORAGE_VERSION);
  });

  it('uses DEFAULT_CONFIG values for defaults', () => {
    const cfg = getDefaultInitial();
    expect(cfg.outputPrefix).toBe(DEFAULT_CONFIG.metadata.channelPrefix);
    expect(cfg.songsPerPlaylist).toBe(DEFAULT_CONFIG.audio.songsPerPlaylist);
    expect(cfg.minDurationHours).toBe(
      DEFAULT_CONFIG.target.minDurationSec / 3600,
    );
  });

  it('sets video/audio sources to null', () => {
    const cfg = getDefaultInitial();
    expect(cfg.videoSource).toBeNull();
    expect(cfg.audioSource).toBeNull();
  });

  it('returns default encoding values', () => {
    const cfg = getDefaultInitial();
    expect(cfg.codec).toBe('av1');
    expect(cfg.maxrate).toBe('4000k');
    expect(cfg.outputFormat).toBe('mp4');
    expect(cfg.embedChapters).toBe(true);
    expect(cfg.skipIntermediateOnCodecMatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadPersistedConfig
// ---------------------------------------------------------------------------
describe('loadPersistedConfig', () => {
  it('returns defaults when localStorage is empty', () => {
    const cfg = loadPersistedConfig();
    expect(cfg.version).toBe(STORAGE_VERSION);
    expect(cfg.videoSource).toBeNull();
  });

  it('returns defaults when version is newer than current (downgrade scenario)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 999 }));
    const cfg = loadPersistedConfig();
    expect(cfg.version).toBe(STORAGE_VERSION);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('restores a previously saved config', () => {
    const saved = {
      version: STORAGE_VERSION,
      videoSource: { type: 'files' as const, paths: ['vid.mp4'] },
      audioSource: { type: 'files' as const, paths: ['aud.mp3'] },
      outputPath: '/out',
      outputPrefix: 'Test',
      maxrate: '3000k',
      usePingpong: false,
      songsPerPlaylist: 5,
      minDurationHours: 2,
      loopMode: 'count' as const,
      loopCount: 3,
      codec: 'h264',
      audioMode: 'normalize' as const,
      embedChapters: false,
      outputFormat: 'mkv' as const,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const loaded = loadPersistedConfig();
    expect(loaded.videoSource).toEqual(saved.videoSource);
    expect(loaded.audioSource).toEqual(saved.audioSource);
    expect(loaded.outputPath).toBe('/out');
    expect(loaded.maxrate).toBe('3000k');
    expect(loaded.codec).toBe('h264');
    expect(loaded.loopCount).toBe(3);
    expect(loaded.embedChapters).toBe(false);
    expect(loaded.outputFormat).toBe('mkv');
  });

  it('falls back to defaults for missing or invalid fields', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        // All fields intentionally missing or invalid
        videoSource: null,
        audioSource: 'invalid',
        maxrate: 5000, // should be string
        loopCount: -1, // below min
      }),
    );
    const cfg = loadPersistedConfig();
    expect(cfg.outputPath).toBe('');
    expect(cfg.maxrate).toBe('4000k'); // fallback
    expect(cfg.loopCount).toBe(1); // min-clamped
    expect(cfg.outputPrefix).toBe(DEFAULT_CONFIG.metadata.channelPrefix);
  });

  it('handles corrupted JSON gracefully', () => {
    localStorage.setItem(STORAGE_KEY, '{broken json');
    const cfg = loadPersistedConfig();
    expect(cfg.version).toBe(STORAGE_VERSION);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('coerces unknown codec to av1', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, codec: 'vp9' }),
    );
    const cfg = loadPersistedConfig();
    expect(cfg.codec).toBe('av1'); // not in allowed list
  });

  it('clamps a stored minDurationHours above 24h down to 24h', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, minDurationHours: 999 }),
    );
    const cfg = loadPersistedConfig();
    expect(cfg.minDurationHours).toBe(24);
  });

  it('handles missing version field (old schema) by resetting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ outputPath: '/old' }));
    const cfg = loadPersistedConfig();
    expect(cfg.version).toBe(STORAGE_VERSION);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('preserves old data when storing and loading from unknown older version (forward migration)', () => {
    // Simulate pre-versioning data (version 0): the migration loop advances
    // the version number without a registered migration function, preserving
    // all known fields and filling new ones with defaults.
    const oldData = {
      version: 0,
      outputPath: '/legacy/path',
      outputPrefix: 'Legacy',
      maxrate: '3000k',
      songsPerPlaylist: 5,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldData));
    const cfg = loadPersistedConfig();
    // Should have migrated forward (0 → current)
    expect(cfg.version).toBe(STORAGE_VERSION);
    // Data fields should be preserved
    expect(cfg.outputPath).toBe('/legacy/path');
    expect(cfg.outputPrefix).toBe('Legacy');
    expect(cfg.maxrate).toBe('3000k');
    expect(cfg.songsPerPlaylist).toBe(5);
    // Fields not in old data should use defaults
    expect(cfg.codec).toBe('av1');
    expect(cfg.outputFormat).toBe('mp4');
  });

  it('preserves migrated data in localStorage for fast next load', () => {
    const oldData = {
      version: 0,
      outputPath: '/migrated',
      maxrate: '2000k',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldData));
    loadPersistedConfig();

    // After migration, localStorage should contain the merged + coerced config
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.version).toBe(STORAGE_VERSION);
    expect(stored.outputPath).toBe('/migrated');
    expect(stored.maxrate).toBe('2000k');
    // New fields should have defaults
    expect(stored.outputFormat).toBe('mp4');
    expect(stored.embedChapters).toBe(true);
  });

  // v1 → v2 migration: introduce the opt-in stream-copy toggle without
  // changing the pre-migration processing behavior.
  it('migrates v1 -> v2 by injecting skipIntermediateOnCodecMatch=false and persisting', () => {
    const oldData = {
      version: 1,
      outputPath: '/pre-migration',
      usePingpong: true,
      codec: 'av1',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldData));

    const cfg = loadPersistedConfig();

    // Migration result: preserved user data + new field defaulted to false.
    // `loadPersistedConfig` returns a plain PersistedConfig object (no getter
    // accessors), so each field is a property, not a function call.
    expect(cfg.version).toBe(STORAGE_VERSION); // 2
    expect(cfg.outputPath).toBe('/pre-migration'); // preserved
    expect(cfg.usePingpong).toBe(true); // preserved (plain property)
    expect(cfg.skipIntermediateOnCodecMatch).toBe(false); // safe default
    // Persisted store should now have the new schema so subsequent loads
    // skip the migration work.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.version).toBe(STORAGE_VERSION);
    expect(stored.skipIntermediateOnCodecMatch).toBe(false);
  });

  it('round-trips skipIntermediateOnCodecMatch=false across localStorage', () => {
    const saved = {
      version: STORAGE_VERSION,
      skipIntermediateOnCodecMatch: false,
      usePingpong: true,
      codec: 'av1',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const cfg = loadPersistedConfig();
    expect(cfg.skipIntermediateOnCodecMatch).toBe(false);
  });
});
