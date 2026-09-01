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
    encoder: string;
    preset: string;
  };
  audio: {
    songsPerPlaylist: number;
    concurrentPrep: number;
    bitrate: string;
    sampleRate: number;
    loudnormParams: string;
    audioMode: string;
  };
  embedChapters: boolean;
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
  timestamps: string[];
}

export type MediaSource =
  | { type: 'folder'; path: string }
  | { type: 'files'; paths: string[] };

export interface HardwareInfo {
  cpuModel: string;
  gpuModel: string;
  totalRamGB: number;
  av1Supported: boolean;
}

export interface JobProgress {
  index: number;
  state: 'pending' | 'processing' | 'done' | 'error';
  progressPercent: number;
  currentStep: string;
  name: string;
  outputPath: string;
  thumbnailPath: string | null;
}

export interface PipelineStats {
  speed: number;
  bitrateKbps: number;
  fps: number;
}

export interface PipelineProgress {
  total: number;
  completed: number;
  jobs: JobProgress[];
}

export interface PipelineLog {
  level: 'info' | 'warn' | 'error' | 'success';
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
  | { type: 'Paused'; data?: undefined }
  | { type: 'FatalError'; data: string }
  | { type: 'Stats'; data: PipelineStats };
