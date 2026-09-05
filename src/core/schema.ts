// Plain config shape + coercion for the persisted settings. No descriptor
// engine: one typed interface, one coercion function, one defaults function.

import type { MediaSource } from './types';
import { DEFAULT_CONFIG, CODECS, ALL_CODECS } from './config';

// ── Shared validation limits ───────────────────────────────────────────

/** Numeric bounds mirrored by Rust validation/limits.rs. */
export const CONFIG_LIMITS = {
  bitrateK: { min: 100, max: 50000 },
  songsPerPlaylist: { min: 1, max: 100 },
  durationHours: { min: 0.1, max: 24 },
  loopCount: { min: 1, max: 100 },
  sampleRate: { min: 8000, max: 192000 },
  concurrentPrep: { min: 1, max: 64 },
  paddingSec: { min: 0, max: 86400 },
  maxSourceFiles: 10000,
  maxResumeStateBytes: 5242880,
  maxResumedTimestamps: 100000,
  maxPrefixLength: 100,
  maxPathLength: 4096,
} as const;

// ── Config shape ───────────────────────────────────────────────────────

export interface SchemaState {
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

export function isMediaSourceValue(value: unknown): value is MediaSource {
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

/** All schema defaults (must match Rust `Default` impls and DEFAULT_CONFIG). */
export function defaultConfigRecord(): SchemaState {
  return {
    videoSource: null,
    audioSource: null,
    outputPath: '',
    outputPrefix: DEFAULT_CONFIG.metadata.channelPrefix,
    maxrate: '4000k',
    usePingpong: true,
    audioMode: 'original',
    embedChapters: true,
    outputFormat: 'mp4',
    songsPerPlaylist: DEFAULT_CONFIG.audio.songsPerPlaylist,
    minDurationHours: DEFAULT_CONFIG.target.minDurationSec / 3600,
    loopMode: 'duration',
    loopCount: 1,
    codec: CODECS.av1,
    skipIntermediateOnCodecMatch: false,
  };
}

const isOneOf = <T extends string>(v: unknown, values: readonly T[]): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

function clampNum(
  raw: unknown,
  limits: { min: number; max: number },
  fallback: number,
  integer: boolean,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const value = integer ? Math.round(raw) : raw;
  return Math.max(limits.min, Math.min(limits.max, value));
}

/**
 * Coerce a raw stored record into a valid {@link SchemaState}. Wrong types
 * fall back to defaults; numbers clamp to the backend validation ranges.
 */
export function coerceFromRecord(raw: Record<string, unknown>): SchemaState {
  const defaults = defaultConfigRecord();
  return {
    videoSource: isMediaSourceValue(raw.videoSource)
      ? raw.videoSource
      : defaults.videoSource,
    audioSource: isMediaSourceValue(raw.audioSource)
      ? raw.audioSource
      : defaults.audioSource,
    outputPath:
      typeof raw.outputPath === 'string' ? raw.outputPath : defaults.outputPath,
    outputPrefix:
      typeof raw.outputPrefix === 'string'
        ? raw.outputPrefix
        : defaults.outputPrefix,
    maxrate: typeof raw.maxrate === 'string' ? raw.maxrate : defaults.maxrate,
    usePingpong:
      typeof raw.usePingpong === 'boolean'
        ? raw.usePingpong
        : defaults.usePingpong,
    audioMode: isOneOf(raw.audioMode, ['original', 'normalize'] as const)
      ? raw.audioMode
      : defaults.audioMode,
    embedChapters:
      typeof raw.embedChapters === 'boolean'
        ? raw.embedChapters
        : defaults.embedChapters,
    outputFormat: isOneOf(raw.outputFormat, ['mp4', 'mkv'] as const)
      ? raw.outputFormat
      : defaults.outputFormat,
    songsPerPlaylist: clampNum(
      raw.songsPerPlaylist,
      CONFIG_LIMITS.songsPerPlaylist,
      defaults.songsPerPlaylist,
      true,
    ),
    minDurationHours: clampNum(
      raw.minDurationHours,
      CONFIG_LIMITS.durationHours,
      defaults.minDurationHours,
      false,
    ),
    loopMode: isOneOf(raw.loopMode, ['duration', 'count'] as const)
      ? raw.loopMode
      : defaults.loopMode,
    loopCount: clampNum(
      raw.loopCount,
      CONFIG_LIMITS.loopCount,
      defaults.loopCount,
      true,
    ),
    codec: isOneOf(raw.codec, ALL_CODECS) ? raw.codec : defaults.codec,
    skipIntermediateOnCodecMatch:
      typeof raw.skipIntermediateOnCodecMatch === 'boolean'
        ? raw.skipIntermediateOnCodecMatch
        : defaults.skipIntermediateOnCodecMatch,
  };
}

/** Build a snapshot (for persistence) from a live state record. */
export function snapshotFromState(
  state: SchemaState,
  version: number,
): SchemaState & { version: number } {
  return { ...state, version };
}
