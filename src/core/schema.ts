// ── Single-source config field schema ──────────────────────────────────
//
// This file is THE contract for every user-adjustable config field.
// Adding a new field requires exactly one edit here plus one line in the
// Rust `OverrideConfig` struct (see `src-tauri/src/models/settings.rs`);
// every other consumer (persisted.ts coercion, usePersistedConfig store,
// buildAppConfig bridge, PipelineApi accessors) derives from this schema.
//
// The `schema.test.ts` golden test asserts the generated contract file
// (`src/core/config-contract.json`) matches this schema, and the Rust side
// has a matching sentinel test that asserts every field in the contract
// exists on `OverrideConfig`.

import type { MediaSource } from './types';
import { DEFAULT_CONFIG, CODECS, ALL_CODECS } from './config';

// ── Field kinds ────────────────────────────────────────────────────────

export type FieldKind =
  | 'mediaSource'
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum';

/** A single config field descriptor. */
export interface FieldDescriptor<T = unknown> {
  /** Field name as used in the store, PipelineApi, and Rust OverrideConfig. */
  readonly name: string;
  readonly kind: FieldKind;
  /** Default value — must match Rust `Default` impls and `DEFAULT_CONFIG`. */
  readonly default: T;
  /** Inclusive range clamp for `number` fields (matches Rust validation). */
  readonly min?: number;
  readonly max?: number;
  /** Round to integer before clamping (for count-like fields). */
  readonly integer?: boolean;
  /** Allowed values for `enum` fields. */
  readonly values?: readonly string[];
  /** Custom validator for `mediaSource` fields. */
  readonly validate?: (value: unknown) => boolean;
}

// ── Validators ─────────────────────────────────────────────────────────

function isMediaSourceValue(value: unknown): value is MediaSource {
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

// ── Schema ─────────────────────────────────────────────────────────────

/**
 * Ordered list of every user-adjustable config field.  Order matters only
 * for the generated contract file; consumers iterate by name.
 */
export const CONFIG_SCHEMA = [
  {
    name: 'videoSource',
    kind: 'mediaSource',
    default: null,
    validate: isMediaSourceValue,
  },
  {
    name: 'audioSource',
    kind: 'mediaSource',
    default: null,
    validate: isMediaSourceValue,
  },
  { name: 'outputPath', kind: 'string', default: '' },
  {
    name: 'outputPrefix',
    kind: 'string',
    default: DEFAULT_CONFIG.metadata.channelPrefix,
  },
  {
    name: 'maxrate',
    kind: 'string',
    default: '4000k',
    // Matches Rust MIN_BITRATE_K..MAX_BITRATE_K; the value is a string
    // like "4000k" so the numeric bounds live in the coercion clamp below.
  },
  { name: 'usePingpong', kind: 'boolean', default: true },
  {
    name: 'audioMode',
    kind: 'enum',
    default: 'original',
    values: ['original', 'normalize'],
  },
  { name: 'embedChapters', kind: 'boolean', default: true },
  {
    name: 'outputFormat',
    kind: 'enum',
    default: 'mp4',
    values: ['mp4', 'mkv'],
  },
  {
    name: 'songsPerPlaylist',
    kind: 'number',
    default: DEFAULT_CONFIG.audio.songsPerPlaylist,
    min: CONFIG_LIMITS.songsPerPlaylist.min,
    max: CONFIG_LIMITS.songsPerPlaylist.max,
    integer: true,
  },
  {
    name: 'minDurationHours',
    kind: 'number',
    default: DEFAULT_CONFIG.target.minDurationSec / 3600,
    min: CONFIG_LIMITS.durationHours.min,
    max: CONFIG_LIMITS.durationHours.max,
  },
  {
    name: 'loopMode',
    kind: 'enum',
    default: 'duration',
    values: ['duration', 'count'],
  },
  {
    name: 'loopCount',
    kind: 'number',
    default: 1,
    min: CONFIG_LIMITS.loopCount.min,
    max: CONFIG_LIMITS.loopCount.max,
    integer: true,
  },
  {
    name: 'codec',
    kind: 'enum',
    default: CODECS.av1,
    values: ALL_CODECS,
  },
  {
    name: 'skipIntermediateOnCodecMatch',
    kind: 'boolean',
    default: false,
  },
] as const satisfies readonly FieldDescriptor[];

/** Map of field name → descriptor, for O(1) lookup by consumers. */
export const CONFIG_FIELDS_BY_NAME: ReadonlyMap<string, FieldDescriptor> =
  new Map(CONFIG_SCHEMA.map((f) => [f.name, f]));

/** Ordered list of field names (the contract's field order). */
export const CONFIG_FIELD_NAMES: readonly string[] = CONFIG_SCHEMA.map(
  (f) => f.name,
);

/** Coerce one field value; exported for schema-level unit tests. */
export function coerceField(
  descriptor: FieldDescriptor,
  raw: unknown,
): unknown {
  if (descriptor.kind === 'mediaSource') {
    return descriptor.validate?.(raw) ? raw : descriptor.default;
  }
  if (descriptor.kind === 'boolean') {
    return typeof raw === 'boolean' ? raw : descriptor.default;
  }
  if (descriptor.kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return descriptor.default;
    }
    let value = raw;
    if (descriptor.integer) value = Math.round(value);
    if (descriptor.min !== undefined) {
      value = Math.max(descriptor.min, value);
    }
    if (descriptor.max !== undefined) {
      value = Math.min(descriptor.max, value);
    }
    return value;
  }
  if (descriptor.kind === 'enum') {
    const values = descriptor.values ?? [];
    return typeof raw === 'string' && values.includes(raw)
      ? raw
      : descriptor.default;
  }
  // string
  return typeof raw === 'string' ? raw : descriptor.default;
}

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

/** Build a fully-coerced config object from a raw stored record. */
export function coerceFromRecord(raw: Record<string, unknown>): SchemaState {
  const result: SchemaState = {
    videoSource: coerceField(
      CONFIG_SCHEMA[0],
      raw.videoSource,
    ) as MediaSource | null,
    audioSource: coerceField(
      CONFIG_SCHEMA[1],
      raw.audioSource,
    ) as MediaSource | null,
    outputPath: coerceField(CONFIG_SCHEMA[2], raw.outputPath) as string,
    outputPrefix: coerceField(CONFIG_SCHEMA[3], raw.outputPrefix) as string,
    maxrate: coerceField(CONFIG_SCHEMA[4], raw.maxrate) as string,
    usePingpong: coerceField(CONFIG_SCHEMA[5], raw.usePingpong) as boolean,
    audioMode: coerceField(CONFIG_SCHEMA[6], raw.audioMode) as
      | 'original'
      | 'normalize',
    embedChapters: coerceField(CONFIG_SCHEMA[7], raw.embedChapters) as boolean,
    outputFormat: coerceField(CONFIG_SCHEMA[8], raw.outputFormat) as
      | 'mp4'
      | 'mkv',
    songsPerPlaylist: coerceField(
      CONFIG_SCHEMA[9],
      raw.songsPerPlaylist,
    ) as number,
    minDurationHours: coerceField(
      CONFIG_SCHEMA[10],
      raw.minDurationHours,
    ) as number,
    loopMode: coerceField(CONFIG_SCHEMA[11], raw.loopMode) as
      | 'duration'
      | 'count',
    loopCount: coerceField(CONFIG_SCHEMA[12], raw.loopCount) as number,
    codec: coerceField(CONFIG_SCHEMA[13], raw.codec) as string,
    skipIntermediateOnCodecMatch: coerceField(
      CONFIG_SCHEMA[14],
      raw.skipIntermediateOnCodecMatch,
    ) as boolean,
  };
  return result;
}

/** Build the default config object (all schema defaults). */
export function defaultConfigRecord(): SchemaState {
  return {
    videoSource: CONFIG_SCHEMA[0].default,
    audioSource: CONFIG_SCHEMA[1].default,
    outputPath: CONFIG_SCHEMA[2].default,
    outputPrefix: CONFIG_SCHEMA[3].default,
    maxrate: CONFIG_SCHEMA[4].default,
    usePingpong: CONFIG_SCHEMA[5].default,
    audioMode: CONFIG_SCHEMA[6].default,
    embedChapters: CONFIG_SCHEMA[7].default,
    outputFormat: CONFIG_SCHEMA[8].default,
    songsPerPlaylist: CONFIG_SCHEMA[9].default,
    minDurationHours: CONFIG_SCHEMA[10].default,
    loopMode: CONFIG_SCHEMA[11].default,
    loopCount: CONFIG_SCHEMA[12].default,
    codec: CONFIG_SCHEMA[13].default,
    skipIntermediateOnCodecMatch: CONFIG_SCHEMA[14].default,
  };
}

/** Build a snapshot (for persistence) from a live state record. */
export function snapshotFromState(
  state: SchemaState,
  version: number,
): Omit<PersistedSchemaSnapshot, 'version'> & { version: number } {
  return {
    version,
    videoSource: state.videoSource,
    audioSource: state.audioSource,
    outputPath: state.outputPath,
    outputPrefix: state.outputPrefix,
    maxrate: state.maxrate,
    usePingpong: state.usePingpong,
    audioMode: state.audioMode,
    embedChapters: state.embedChapters,
    outputFormat: state.outputFormat,
    songsPerPlaylist: state.songsPerPlaylist,
    minDurationHours: state.minDurationHours,
    loopMode: state.loopMode,
    loopCount: state.loopCount,
    codec: state.codec,
    skipIntermediateOnCodecMatch: state.skipIntermediateOnCodecMatch,
  };
}

export interface PersistedSchemaSnapshot extends SchemaState {
  version: number;
}
