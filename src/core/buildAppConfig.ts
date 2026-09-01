import type { AppConfig } from './types';
import { DEFAULT_CONFIG } from './config';

/**
 * Subset of user-adjustable settings that map 1:1 to fields in the Rust
 * `AppConfig` struct (see `src-tauri/src/config.rs`).  Every field here has
 * a corresponding line in {@link buildAppConfig}; remaining `AppConfig`
 * fields come from {@link DEFAULT_CONFIG}.
 *
 * Previously named `PersistedConfigState` — renamed to clarify that this
 * is the frontend→backend bridge shape, not the localStorage schema (which
 * lives in {@link PersistedConfig} in `core/persisted.ts`).
 */
export interface BackendConfigSnapshot {
  readonly outputPath: () => string;
  readonly outputPrefix: () => string;
  readonly minDurationHours: () => number;
  readonly maxrate: () => string;
  readonly codec: () => string;
  readonly songsPerPlaylist: () => number;
  readonly audioMode: () => 'original' | 'normalize';
  readonly embedChapters: () => boolean;
}

export type BackendConfigAccessors = BackendConfigSnapshot;

export function buildAppConfig(
  config: BackendConfigSnapshot,
  resolveEncoder: (codec: string) => string,
): AppConfig {
  return {
    directories: {
      // Directory paths sent to the backend are intentionally kept as-is
      // (possibly relative).  `start_render` and `save_config` on the Rust
      // side always pass them through `fs::to_absolute` before use, so
      // relative paths resolve correctly against the Tauri process CWD.
      video: DEFAULT_CONFIG.directories.video,
      audio: DEFAULT_CONFIG.directories.audio,
      output: config.outputPath() || DEFAULT_CONFIG.directories.output,
      cache: DEFAULT_CONFIG.directories.cache,
    },
    metadata: {
      channelPrefix:
        config.outputPrefix() || DEFAULT_CONFIG.metadata.channelPrefix,
    },
    target: {
      minDurationSec: Math.round((config.minDurationHours() || 1) * 3600),
      paddingSec: DEFAULT_CONFIG.target.paddingSec,
    },
    video: {
      bitrateTarget: config.maxrate() || DEFAULT_CONFIG.video.bitrateTarget,
      bitrateMax: config.maxrate() || DEFAULT_CONFIG.video.bitrateMax,
      encoder: resolveEncoder(config.codec()),
      preset: DEFAULT_CONFIG.video.preset,
    },
    audio: {
      songsPerPlaylist:
        config.songsPerPlaylist() || DEFAULT_CONFIG.audio.songsPerPlaylist,
      concurrentPrep: DEFAULT_CONFIG.audio.concurrentPrep,
      bitrate: DEFAULT_CONFIG.audio.bitrate,
      sampleRate: DEFAULT_CONFIG.audio.sampleRate,
      loudnormParams: DEFAULT_CONFIG.audio.loudnormParams,
      audioMode: config.audioMode(),
    },
    embedChapters: config.embedChapters(),
  };
}
