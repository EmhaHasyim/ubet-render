import { createEffect, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  STORAGE_KEY,
  STORAGE_VERSION,
  loadPersistedConfig,
  type PersistedConfig,
} from '../core/persisted';
import { safeSetStorageItem } from '../core/storage';
import {
  CONFIG_SCHEMA,
  snapshotFromState,
  type SchemaState,
} from '../core/schema';

// ── State interface ────────────────────────────────────────────────────
// Derived from the single-source schema: one field descriptor in
// `core/schema.ts` covers store shape, snapshot, coercion and clamping.
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
  const [state, setState] = createStore<SchemaState>({
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
    const snapshot: PersistedConfig = snapshotFromState(state, STORAGE_VERSION);
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

  // ── Setters ──────────────────────────────────────────────────────────
  // Numeric setters clamp via the schema bounds; the rest write directly.
  const clampSetter = (name: string) => (v: number) => {
    const field: import('../core/schema').FieldDescriptor | undefined =
      CONFIG_SCHEMA.find((f) => f.name === name);
    let value = v;
    if (field?.integer) value = Math.round(value) || (field.min ?? 1);
    if (field?.min !== undefined) value = Math.max(field.min, value);
    if (field?.max !== undefined) value = Math.min(field.max, value);
    if (name === 'songsPerPlaylist') setState('songsPerPlaylist', value);
    else if (name === 'minDurationHours') setState('minDurationHours', value);
    else if (name === 'loopCount') setState('loopCount', value);
  };

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

    // ---- Setters (numeric ones clamp to schema bounds = backend limits) ----
    setVideoSource: (v: import('../core/types').MediaSource | null) =>
      setState('videoSource', v),
    setAudioSource: (v: import('../core/types').MediaSource | null) =>
      setState('audioSource', v),
    setOutputPath: (v: string) => setState('outputPath', v),
    setOutputPrefix: (v: string) => setState('outputPrefix', v),
    setMaxrate: (v: string) => setState('maxrate', v),
    setUsePingpong: (v: boolean) => setState('usePingpong', v),
    setSongsPerPlaylist: clampSetter('songsPerPlaylist'),
    setMinDurationHours: clampSetter('minDurationHours'),
    setLoopMode: (v: 'duration' | 'count') => setState('loopMode', v),
    setLoopCount: clampSetter('loopCount'),
    setCodec: (v: string) => setState('codec', v),
    setAudioMode: (v: 'original' | 'normalize') => setState('audioMode', v),
    setEmbedChapters: (v: boolean) => setState('embedChapters', v),
    setOutputFormat: (v: 'mp4' | 'mkv') => setState('outputFormat', v),
    setSkipIntermediateOnCodecMatch: (v: boolean) =>
      setState('skipIntermediateOnCodecMatch', v),
  };
}
