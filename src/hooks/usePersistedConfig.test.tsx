/**
 * Tests for usePersistedConfig.
 *
 * This hook only depends on SolidJS primitives and the localStorage
 * polyfill already set up in test-setup.ts — no Tauri mocking needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { STORAGE_KEY, STORAGE_VERSION } from '../core/persisted';

// We must import SolidJS's createRoot so we can mount the hook
// inside a reactive root outside of a component context.
import { createRoot } from 'solid-js';
import { usePersistedConfig } from './usePersistedConfig';

/** Mount a hook inside a SolidJS reactive root and return its value. */
function mountHook<T>(fn: () => T): T {
  let result!: T;
  createRoot((dispose) => {
    result = fn();
    return dispose;
  });
  return result;
}

describe('usePersistedConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns default values when localStorage is empty', () => {
    const c = mountHook(() => usePersistedConfig());
    expect(c.codec()).toBe('av1');
    expect(c.maxrate()).toBe('4000k');
    expect(c.songsPerPlaylist()).toBe(9);
    expect(c.minDurationHours()).toBe(1);
    expect(c.outputPrefix()).toBe('Ubet Render');
    expect(c.outputPath()).toBe('');
    expect(c.outputFormat()).toBe('mp4');
    expect(c.audioMode()).toBe('original');
    expect(c.loopMode()).toBe('duration');
    expect(c.loopCount()).toBe(1);
    expect(c.usePingpong()).toBe(true);
    expect(c.embedChapters()).toBe(true);
    expect(c.videoSource()).toBeNull();
    expect(c.audioSource()).toBeNull();
  });

  it('returns persisted values from localStorage', () => {
    const saved = {
      version: STORAGE_VERSION,
      videoSource: { type: 'files' as const, paths: ['/v/test.mp4'] },
      audioSource: null,
      outputPath: '/out',
      outputPrefix: 'My Channel',
      maxrate: '8000k',
      usePingpong: false,
      songsPerPlaylist: 15,
      minDurationHours: 2.5,
      loopMode: 'count' as const,
      loopCount: 3,
      codec: 'h265',
      audioMode: 'normalize' as const,
      embedChapters: false,
      outputFormat: 'mkv' as const,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const c = mountHook(() => usePersistedConfig());
    expect(c.codec()).toBe('h265');
    expect(c.maxrate()).toBe('8000k');
    expect(c.songsPerPlaylist()).toBe(15);
    expect(c.outputPath()).toBe('/out');
    expect(c.outputFormat()).toBe('mkv');
  });

  it('falls back to defaults when localStorage has wrong version', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, codec: 'h264', maxrate: '99999k' }),
    );
    const c = mountHook(() => usePersistedConfig());
    // Must use defaults since version doesn't match
    expect(c.codec()).toBe('av1');
    expect(c.maxrate()).toBe('4000k');
  });

  it('falls back to defaults when localStorage has corrupted JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{corrupted');
    const c = mountHook(() => usePersistedConfig());
    expect(c.codec()).toBe('av1');
    expect(c.outputPath()).toBe('');
  });

  it('allows setting values via setters', () => {
    const c = mountHook(() => usePersistedConfig());
    c.setCodec('h264');
    c.setMaxrate('2000k');
    c.setOutputPath('/custom/out');

    expect(c.codec()).toBe('h264');
    expect(c.maxrate()).toBe('2000k');
    expect(c.outputPath()).toBe('/custom/out');
  });

  it('clamps songsPerPlaylist to valid range (1-100)', () => {
    const c = mountHook(() => usePersistedConfig());
    c.setSongsPerPlaylist(-5);
    expect(c.songsPerPlaylist()).toBe(1);
    c.setSongsPerPlaylist(0);
    expect(c.songsPerPlaylist()).toBe(1);
    c.setSongsPerPlaylist(200);
    expect(c.songsPerPlaylist()).toBe(100);
  });
});
