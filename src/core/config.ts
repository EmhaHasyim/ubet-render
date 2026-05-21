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
    fps: 30,
    encoder: 'av1_nvenc',
    preset: 'p6',
  },
  audio: {
    songsPerPlaylist: 9,
    concurrentPrep: 5,
    bitrate: '192k',
    sampleRate: 44100,
    loudnormParams: 'I=-14:LRA=11:TP=-1',
  },
  youtubeTimestamps: true,
};

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
