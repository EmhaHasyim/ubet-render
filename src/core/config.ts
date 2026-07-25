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

// IMPORTANT: These extension lists MUST stay in sync with the Rust constants
// in `src-tauri/src/validation.rs` (VIDEO_EXTENSIONS / AUDIO_EXTENSIONS) and
// `src-tauri/src/pipeline/source_scanner.rs`.
// When adding or removing an extension here, mirror the change in the Rust side
// so that frontend drag-and-drop filtering and backend directory scanning
// agree on which files are eligible.
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
