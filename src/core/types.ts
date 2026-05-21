export interface AppConfig {
  directories: {
    video: string;
    audio: string;
    output: string;
    cache: string;
  };
  metadata: {
    channelPrefix: string;
  };
  target: {
    minDurationSec: number;
    paddingSec: number;
  };
  video: {
    bitrateTarget: string;
    bitrateMax: string;
    fps: number;
    encoder: string;
    preset: string;
  };
  audio: {
    songsPerPlaylist: number;
    concurrentPrep: number;
    bitrate: string;
    sampleRate: number;
    loudnormParams: string;
  };
  youtubeTimestamps: boolean;
}

export interface RenderJob {
  video: {
    name: string;
    inputPath: string;
    outputPath: string;
    thumbnailPath?: string;
  };
  state: 'pending' | 'processing' | 'done' | 'error';
  progressPercent: number;
  currentStep: string;
  error?: string;
}

export type MediaSource = { type: 'files'; paths: string[] };

// Event dari backend Rust
export interface PipelineProgress {
  total: number;
  completed: number;
  current_video: string;
  jobs: RenderJob[];
}

export interface PipelineLog {
  level: 'info' | 'error' | 'success';
  message: string;
}

export interface PipelineDone {
  completed: number;
  total: number;
  failed: number;
}

export type PipelineEvent =
  | { type: 'Progress'; data: PipelineProgress }
  | { type: 'Log'; data: PipelineLog }
  | { type: 'Done'; data: PipelineDone }
  | { type: 'Cancelled'; data: string }
  | { type: 'FatalError'; data: string };
