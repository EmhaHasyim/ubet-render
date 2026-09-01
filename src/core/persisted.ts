/**
 * Pure, framework-agnostic helpers for local-storage persistence.
 * Extracted from {@link usePersistedConfig} so they can be unit-tested without
 * SolidJS or Tauri.
 *
 * # Schema Versioning & Migration
 *
 * When the shape of {@link PersistedConfig} changes (field added / removed /
 * renamed), increment {@link STORAGE_VERSION} and add a migration function to
 * the {@link MIGRATIONS} map.  Each migration receives the stored object from
 * the previous version and returns a partial that gets merged forward through
 * every intermediate version until the current one.
 *
 * This allows users to upgrade the app without losing their saved settings.
 *
 * # Single-source field schema (v0.3.0)
 *
 * Field names, defaults, and coercion rules now live in `core/schema.ts`
 * ({@link CONFIG_SCHEMA}).  This module keeps the versioned-storage concerns
 * (key, version, migrations) and delegates all per-field coercion to the
 * schema, so a new field needs no edit here at all.
 */
import type { MediaSource } from './types';
import { safeSetStorageItem } from './storage';
import { coerceFromRecord, defaultConfigRecord } from './schema';

export const STORAGE_KEY = 'ubetrender-paths';
export const STORAGE_VERSION = 3;

/** The persisted config shape. Field list, defaults, and coercion rules
 *  live in `core/schema.ts` ({@link CONFIG_SCHEMA}); the golden contract test
 *  (`schema.test.ts` + `config-contract.json`) pins this interface to the
 *  schema so they cannot drift. */
export interface PersistedConfig {
  version: number;
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  songsPerPlaylist: number;
  minDurationHours: number;
  loopMode: 'duration' | 'count';
  loopCount: number;
  codec: string;
  audioMode: 'original' | 'normalize';
  embedChapters: boolean;
  outputFormat: 'mp4' | 'mkv';
  /** When true, the intermediate re-encode step is bypassed entirely —
   *  the source video is fed directly to the concat demuxer via stream-copy,
   *  regardless of codec. Disabled by default. */
  skipIntermediateOnCodecMatch: boolean;
}

/**
 * Migration registry.
 *
 * Key = source version number (the version the stored data is currently at).
 * Value = function that receives the data object (without version field)
 *         and returns the partial updates needed to reach the *next* version.
 *
 * Example: to migrate from version 1 → 2, add:
 * ```ts
 * MIGRATIONS.set(1, (prev) => ({ newField: defaultValue }));
 * ```
 * Then increment `STORAGE_VERSION` to 2.
 */
export const MIGRATIONS = new Map<
  number,
  (prev: Record<string, unknown>) => Record<string, unknown>
>();

// v1 → v2: introduce `skipIntermediateOnCodecMatch` as an explicit opt-in
// for stream-copy without intermediate re-encode. Disabled by default (v0.2.7+
// makes this unconditional when ON, bypassing codec matching entirely).
MIGRATIONS.set(1, (_prev) => ({
  // Preserve the previous default behavior: apply the configured video
  // processing pipeline unless the user explicitly opts into stream-copy.
  skipIntermediateOnCodecMatch: false,
}));

export function isMediaSource(value: unknown): value is MediaSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  if (source.type === 'files') {
    return (
      Array.isArray(source.paths) &&
      (source.paths as unknown[]).every((p) => typeof p === 'string')
    );
  }
  if (source.type === 'folder') {
    return typeof source.path === 'string';
  }
  return false;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function numberOr(
  value: unknown,
  fallback: number,
  min: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? value
    : fallback;
}

export function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function getDefaultInitial(): PersistedConfig {
  const defaults = defaultConfigRecord();
  return {
    version: STORAGE_VERSION,
    videoSource: defaults.videoSource as MediaSource | null,
    audioSource: defaults.audioSource as MediaSource | null,
    outputPath: defaults.outputPath as string,
    outputPrefix: defaults.outputPrefix as string,
    maxrate: defaults.maxrate as string,
    usePingpong: defaults.usePingpong as boolean,
    songsPerPlaylist: defaults.songsPerPlaylist as number,
    minDurationHours: defaults.minDurationHours as number,
    loopMode: defaults.loopMode as 'duration' | 'count',
    loopCount: defaults.loopCount as number,
    codec: defaults.codec as string,
    audioMode: defaults.audioMode as 'original' | 'normalize',
    embedChapters: defaults.embedChapters as boolean,
    outputFormat: defaults.outputFormat as 'mp4' | 'mkv',
    skipIntermediateOnCodecMatch:
      defaults.skipIntermediateOnCodecMatch as boolean,
  };
}

/**
 * Safely coerce a parsed JSON value into a {@link PersistedConfig}.
 * Each field is validated individually by the schema and falls back to a
 * sensible default when the stored value is missing, wrong type, or out of
 * range.
 */
function coerceConfig(raw: Record<string, unknown>): PersistedConfig {
  const values = coerceFromRecord(raw);
  return {
    version: STORAGE_VERSION,
    videoSource: values.videoSource as MediaSource | null,
    audioSource: values.audioSource as MediaSource | null,
    outputPath: values.outputPath as string,
    outputPrefix: values.outputPrefix as string,
    maxrate: values.maxrate as string,
    usePingpong: values.usePingpong as boolean,
    songsPerPlaylist: values.songsPerPlaylist as number,
    minDurationHours: values.minDurationHours as number,
    loopMode: values.loopMode as 'duration' | 'count',
    loopCount: values.loopCount as number,
    codec: values.codec as string,
    audioMode: values.audioMode as 'original' | 'normalize',
    embedChapters: values.embedChapters as boolean,
    outputFormat: values.outputFormat as 'mp4' | 'mkv',
    skipIntermediateOnCodecMatch:
      values.skipIntermediateOnCodecMatch as boolean,
  };
}

/** Attempt to parse saved config from localStorage. Returns defaults on any error. */
export function loadPersistedConfig(): PersistedConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultInitial();

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      // Not valid JSON object — reset
      localStorage.removeItem(STORAGE_KEY);
      return getDefaultInitial();
    }

    const storedVersion = (parsed as Record<string, unknown>).version;
    const currentVersion = STORAGE_VERSION;

    // Same version — direct coercion
    if (storedVersion === currentVersion) {
      return coerceConfig(parsed as Record<string, unknown>);
    }

    // Unknown / corrupted version — reset
    if (typeof storedVersion !== 'number' || !Number.isFinite(storedVersion)) {
      localStorage.removeItem(STORAGE_KEY);
      return getDefaultInitial();
    }

    // Stored version is OLDER than current — run migrations forward
    if (storedVersion < currentVersion) {
      let migrated: Record<string, unknown> = {
        ...(parsed as Record<string, unknown>),
      };

      for (let v = storedVersion; v < currentVersion; v++) {
        const migrateFn = MIGRATIONS.get(v);
        if (migrateFn) {
          const patch = migrateFn(migrated);
          Object.assign(migrated, patch);
        }
        migrated.version = v + 1;
      }

      // Merge over defaults so any genuinely new fields get defaults too
      const merged = { ...getDefaultInitial(), ...migrated };

      // Persist the migrated config back so next load is faster
      safeSetStorageItem(STORAGE_KEY, JSON.stringify(merged));

      return coerceConfig(merged);
    }

    // Stored version is NEWER than current (downgrade) — reset
    localStorage.removeItem(STORAGE_KEY);
    return getDefaultInitial();
  } catch (err) {
    // JSON.parse failed or localStorage unavailable – start fresh
    if (err instanceof SyntaxError) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* noop */
      }
    }
    return getDefaultInitial();
  }
}
