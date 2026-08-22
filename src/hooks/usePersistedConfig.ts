import { createEffect, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { MediaSource } from '../core/types';
import {
  STORAGE_KEY,
  STORAGE_VERSION,
  loadPersistedConfig,
  type PersistedConfig,
} from '../core/persisted';
import { safeSetStorageItem } from '../core/storage';

// ── Field registry ─────────────────────────────────────────────────────
// Adding a new config field requires updating only this list, the
// PersistedState interface, and the PipelineApi context contract.
const CONFIG_FIELDS = [
  'videoSource',
  'audioSource',
  'outputPath',
  'outputPrefix',
  'maxrate',
  'usePingpong',
  'audioMode',
  'embedChapters',
  'outputFormat',
  'songsPerPlaylist',
  'minDurationHours',
  'loopMode',
  'loopCount',
  'codec',
  'skipIntermediateOnCodecMatch',
] as const;

// ── State interface ────────────────────────────────────────────────────

interface PersistedState {
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  audioMode: 'original' | 'normalize';
  embedChapters: boolean;
  outputFormat: 'mp4' | 'mkv';
  songsPerPlaylist: number;
  minDurationHours: number;
  loopMode: 'duration' | 'count';
  loopCount: number;
  codec: string;
  skipIntermediateOnCodecMatch: boolean;
}

// ── Derived helpers ────────────────────────────────────────────────────

/** Build a PersistedConfig snapshot from the current store state.
 *  Adding a field to CONFIG_FIELDS automatically includes it here. */
function buildSnapshot(
  state: PersistedState,
  version: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = { version };
  for (const field of CONFIG_FIELDS) {
    base[field] = state[field];
  }
  return base;
}

// ── Persistence helpers ────────────────────────────────────────────────

/**
 * Persist a snapshot to localStorage, swallowing quota/storage errors.
 * Module-level so the debounced writer isn't recreated on every render.
 */
function writeSnapshot(snapshot: PersistedConfig): void {
  safeSetStorageItem(STORAGE_KEY, JSON.stringify(snapshot));
}

// ── Hook ───────────────────────────────────────────────────────────────

export function usePersistedConfig() {
  const initial = loadPersistedConfig();

  // Single reactive store instead of 17 individual createSignal calls.
  // All fields share one reactive root, which means SolidJS tracks a single
  // dependency in effects that read multiple fields, reducing bookkeeping.
  const [state, setState] = createStore<PersistedState>({
    videoSource: initial.videoSource,
    audioSource: initial.audioSource,
    outputPath: initial.outputPath,
    outputPrefix: initial.outputPrefix,
    maxrate: initial.maxrate,
    usePingpong: initial.usePingpong,
    audioMode: initial.audioMode,
    embedChapters: initial.embedChapters,
    outputFormat: initial.outputFormat,
    songsPerPlaylist: initial.songsPerPlaylist,
    minDurationHours: initial.minDurationHours,
    loopMode: initial.loopMode,
    loopCount: initial.loopCount,
    codec: initial.codec,
    skipIntermediateOnCodecMatch: initial.skipIntermediateOnCodecMatch,
  });

  // Debounced persist to localStorage whenever any field changes.
  // Reads from `state` directly — SolidJS's store tracks individual key
  // access so this effect only re-runs when a field actually used below
  // has changed (not when ANY field changes).
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Latest snapshot, kept so the pending debounced write can be flushed
  // synchronously if the hook unmounts before the timer fires (otherwise
  // the most recent field change would be silently lost).
  let latestSnapshot: PersistedConfig | null = null;

  createEffect(() => {
    const snapshot = buildSnapshot(
      state,
      STORAGE_VERSION,
    ) as unknown as PersistedConfig;
    latestSnapshot = snapshot;
    // Clear any pending timer before setting a new one — avoids creating
    // N timers when the user changes N fields rapidly.
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeSnapshot(snapshot);
    }, 300);
  });

  // Flush any pending debounced write on unmount so the last field change
  // isn't lost (e.g. when the ErrorBoundary remounts the pipeline).
  onCleanup(() => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (latestSnapshot !== null) {
      writeSnapshot(latestSnapshot);
    }
  });

  return {
    // ---- Getters ----
    videoSource: () => state.videoSource,
    audioSource: () => state.audioSource,
    outputPath: () => state.outputPath,
    outputPrefix: () => state.outputPrefix,
    maxrate: () => state.maxrate,
    usePingpong: () => state.usePingpong,
    songsPerPlaylist: () => state.songsPerPlaylist,
    minDurationHours: () => state.minDurationHours,
    loopMode: () => state.loopMode,
    loopCount: () => state.loopCount,
    codec: () => state.codec,
    audioMode: () => state.audioMode,
    embedChapters: () => state.embedChapters,
    outputFormat: () => state.outputFormat,
    skipIntermediateOnCodecMatch: () => state.skipIntermediateOnCodecMatch,

    // ---- Setters (explicit — several have clamping logic) ----
    setVideoSource: (v: MediaSource | null) => setState('videoSource', v),
    setAudioSource: (v: MediaSource | null) => setState('audioSource', v),
    setOutputPath: (v: string) => setState('outputPath', v),
    setOutputPrefix: (v: string) => setState('outputPrefix', v),
    setMaxrate: (v: string) => setState('maxrate', v),
    setUsePingpong: (v: boolean) => setState('usePingpong', v),
    setSongsPerPlaylist: (v: number) =>
      setState(
        'songsPerPlaylist',
        Math.max(1, Math.min(100, Math.round(v)) || 1),
      ),
    // Clamped to 0.1–24h to match the backend's validation range
    // (MIN_DURATION_HOURS..=MAX_DURATION_HOURS in validation.rs). Without the
    // upper bound a value like 30 would pass the UI but hard-fail start_render.
    setMinDurationHours: (v: number) =>
      setState('minDurationHours', Math.min(24, Math.max(0.1, v || 0.1))),
    setLoopMode: (v: 'duration' | 'count') => setState('loopMode', v),
    setLoopCount: (v: number) =>
      setState('loopCount', Math.max(1, Math.min(100, Math.round(v)) || 1)),
    setCodec: (v: string) => setState('codec', v),
    setAudioMode: (v: 'original' | 'normalize') => setState('audioMode', v),
    setEmbedChapters: (v: boolean) => setState('embedChapters', v),
    setOutputFormat: (v: 'mp4' | 'mkv') => setState('outputFormat', v),
    setSkipIntermediateOnCodecMatch: (v: boolean) =>
      setState('skipIntermediateOnCodecMatch', v),
  };
}
