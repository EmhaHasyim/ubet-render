import type { AppConfig } from './types';

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
    loudnormParams: 'I=-14:LRA=11:TP=-1',
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
];
