import type { AppConfig, MediaSource } from './types';

// ── Named constants (shared across the frontend) ─────────────────────

/** Canonical codec identifiers sent to the Rust backend. */
export const CODECS = {
  h264: 'h264',
  h265: 'h265',
  av1: 'av1',
} as const;

export type CodecId = (typeof CODECS)[keyof typeof CODECS];

/** All recognised codec ids — used for validation coercion in persisted config. */
export const ALL_CODECS: readonly string[] = [
  CODECS.h264,
  CODECS.h265,
  CODECS.av1,
];

/** EBU R128 loudness normalisation parameters for libebur128.
 *  - I=-14 : integrated loudness target −14 LUFS (YouTube Music spec)
 *  - LRA=11 : loudness range 11 LU
 *  - TP=-1  : true peak −1 dBFS (headroom for lossy encoding)
 *  Sent as `loudnorm` filter parameters to FFmpeg in normalize mode. */
export const LOUDNORM_PARAMS = 'I=-14:LRA=11:TP=-1';

/** Stable empty array reference so bindings don't allocate a fresh
 *  `[]` on every reactive re-evaluation when a source is unset.
 *  Used by {@link getSourcePaths} and {@link SettingsCard}. */
export const EMPTY_PATHS: readonly string[] = Object.freeze(
  [],
) as readonly string[];

/** Extract file paths from a MediaSource regardless of variant. */
export function getSourcePaths(source: MediaSource | null): readonly string[] {
  if (source?.type === 'files' && source.paths.length > 0) return source.paths;
  if (source?.type === 'folder' && source.path.length > 0) return [source.path];
  return EMPTY_PATHS;
}

// ── Default config ────────────────────────────────────────────────────

export const DEFAULT_CONFIG: AppConfig = {
  directories: {
    video: './videos',
    audio: './audios',
    output: './outputs',
    cache: './cache',
  },
  metadata: {
    channelPrefix: 'Ubet Render',
  },
  target: {
    minDurationSec: 3600,
    paddingSec: 10,
  },
  video: {
    bitrateTarget: '4000k',
    bitrateMax: '5000k',
    encoder: 'av1_nvenc',
    preset: 'p6',
  },
  audio: {
    songsPerPlaylist: 9,
    concurrentPrep: 5,
    bitrate: '192k',
    sampleRate: 44100,
    loudnormParams: LOUDNORM_PARAMS,
    audioMode: 'original',
  },
  embedChapters: true,
};

// The canonical allow-list of accepted media extensions is documented in
// `docs/MEDIA_EXTENSIONS.md` — that file is the contract; this list and the
// Rust constants below are the implementations that must stay in sync.
//
// Adding a new extension requires updating FOUR places:
//   1. docs/MEDIA_EXTENSIONS.md
//   2. this file (VIDEO_EXTENSIONS / AUDIO_EXTENSIONS)
//   3. src-tauri/src/pipeline/estimator.rs (and validation.rs if relevant)
//   4. the EXPECTED_* sentinel list in BOTH:
//        - src/core/config.test.ts (TypeScript sentinel)
//        - src-tauri/src/validation.rs   (Rust sentinel)
//
// Both tests assert that their `EXPECTED_*` list (the same canonical
// contract, written twice in two languages for symmetry) equals the
// implementation constants. The doc is the human-readable truth, the
// EXPECTED_* lists are the machine-enforced truth; an implementation that
// drifts from either fails CI.
export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.mov',
  '.webm',
  '.avi',
  '.flv',
  '.wmv',
];
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.flac',
  '.ogg',
  '.aac',
  '.wma',
  '.opus',
  '.aiff',
  '.aif',
];
