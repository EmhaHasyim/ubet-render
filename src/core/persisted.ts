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
 */
import { DEFAULT_CONFIG } from './config';
import type { MediaSource } from './types';

export const STORAGE_KEY = 'ubetrender-paths';
export const STORAGE_VERSION = 2;

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
  /// When true (default), a codec-matched source is concatenated via the
  /// concat demuxer with `-c copy` and the intermediate re-encode step is
  /// bypassed. Honors the README's "Zero-Reencode Muxing" promise.
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

// v1 → v2: introduce `skipIntermediateOnCodecMatch` so that codec-matched
// sources (e.g. AV1→AV1) bypass the pre-encode step and are muxed with
// `-c copy`. Honors the README's "Zero-Reencode Muxing" promise.
MIGRATIONS.set(1, (_prev) => ({
  skipIntermediateOnCodecMatch: true,
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
  return {
    version: STORAGE_VERSION,
    videoSource: null,
    audioSource: null,
    outputPath: '',
    outputPrefix: DEFAULT_CONFIG.metadata.channelPrefix,
    maxrate: '4000k',
    usePingpong: true,
    songsPerPlaylist: DEFAULT_CONFIG.audio.songsPerPlaylist,
    minDurationHours: DEFAULT_CONFIG.target.minDurationSec / 3600,
    loopMode: 'duration',
    loopCount: 1,
    codec: 'av1',
    audioMode: 'original',
    embedChapters: true,
    outputFormat: 'mp4',
    skipIntermediateOnCodecMatch: true,
  };
}

/**
 * Safely coerce a parsed JSON value into a {@link PersistedConfig}.
 * Each field is validated individually and falls back to a sensible default
 * when the stored value is missing, wrong type, or out of range.
 */
function coerceConfig(raw: Record<string, unknown>): PersistedConfig {
  return {
    version: STORAGE_VERSION,
    videoSource: isMediaSource(raw.videoSource) ? raw.videoSource : null,
    audioSource: isMediaSource(raw.audioSource) ? raw.audioSource : null,
    outputPath: stringOr(raw.outputPath, ''),
    outputPrefix: stringOr(
      raw.outputPrefix,
      DEFAULT_CONFIG.metadata.channelPrefix,
    ),
    maxrate: stringOr(raw.maxrate, '4000k'),
    usePingpong: booleanOr(raw.usePingpong, true),
    songsPerPlaylist: numberOr(
      raw.songsPerPlaylist,
      DEFAULT_CONFIG.audio.songsPerPlaylist,
      1,
    ),
    // Clamp to the same 0.1–24h range the backend validates, so a corrupted
    // or hand-edited stored value can never produce a render that fails
    // validation on the Rust side.
    minDurationHours: Math.min(
      24,
      numberOr(
        raw.minDurationHours,
        DEFAULT_CONFIG.target.minDurationSec / 3600,
        0.1,
      ),
    ),
    loopMode: raw.loopMode === 'count' ? 'count' : 'duration',
    loopCount: numberOr(raw.loopCount, 1, 1),
    audioMode: (raw.audioMode === 'normalize' ? 'normalize' : 'original') as
      | 'original'
      | 'normalize',
    embedChapters: booleanOr(raw.embedChapters, true),
    outputFormat: raw.outputFormat === 'mkv' ? 'mkv' : 'mp4',
    codec: ['h264', 'h265', 'av1'].includes(String(raw.codec))
      ? String(raw.codec)
      : 'av1',
    // Default ON so we honor the README's "Zero-Reencode" promise when the
    // stored config omits the field (e.g. corrupted or pre-migration).
    skipIntermediateOnCodecMatch: booleanOr(
      raw.skipIntermediateOnCodecMatch,
      true,
    ),
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
          migrated = { ...migrated, ...patch };
        }
        migrated.version = v + 1;
      }

      // Merge over defaults so any genuinely new fields get defaults too
      const merged = { ...getDefaultInitial(), ...migrated };

      // Persist the migrated config back so next load is faster
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* quota exceeded — ignore */
      }

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
