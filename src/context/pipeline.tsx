import { createContext, useContext, type Accessor, type JSX } from 'solid-js';
import type {
  HardwareInfo,
  JobProgress,
  MediaSource,
  PipelineStats,
} from '../core/types';

type DropZone = 'video' | 'audio' | 'output';

/**
 * Stable frontend contract for the pipeline state and actions.
 *
 * Keeping this contract independent from `usePipeline` lets the hook evolve
 * internally without forcing every context consumer and test double to depend
 * on its inferred implementation return type.
 */
export interface PipelineApi {
  running: Accessor<boolean>;
  paused: Accessor<boolean>;
  jobs: Accessor<JobProgress[]>;
  overallProgress: Accessor<number>;
  overallEta: Accessor<string>;
  logs: Accessor<string[]>;
  liveStats: Accessor<PipelineStats | null>;
  hardwareInfo: Accessor<HardwareInfo | null>;
  av1Supported: Accessor<boolean>;
  hasFailed: Accessor<boolean>;
  canStart: Accessor<boolean>;
  maxrateValid: Accessor<boolean>;
  disabledReason: Accessor<string>;
  dragHover: Accessor<DropZone | null>;

  startRender: (resume?: boolean) => Promise<void>;
  resumeRender: () => Promise<void>;
  cancelRender: () => Promise<void>;
  pauseRender: () => Promise<void>;
  retryJob: () => Promise<void>;

  videoSource: Accessor<MediaSource | null>;
  audioSource: Accessor<MediaSource | null>;
  outputPath: Accessor<string>;
  outputPrefix: Accessor<string>;
  maxrate: Accessor<string>;
  usePingpong: Accessor<boolean>;
  songsPerPlaylist: Accessor<number>;
  minDurationHours: Accessor<number>;
  loopMode: Accessor<'duration' | 'count'>;
  loopCount: Accessor<number>;
  codec: Accessor<string>;
  audioMode: Accessor<'original' | 'normalize'>;
  embedChapters: Accessor<boolean>;
  outputFormat: Accessor<'mp4' | 'mkv'>;
  skipIntermediateOnCodecMatch: Accessor<boolean>;

  setVideoSource: (value: MediaSource | null) => void;
  setAudioSource: (value: MediaSource | null) => void;
  setOutputPath: (value: string) => void;
  setOutputPrefix: (value: string) => void;
  setMaxrate: (value: string) => void;
  setUsePingpong: (value: boolean) => void;
  setSongsPerPlaylist: (value: number) => void;
  setMinDurationHours: (value: number) => void;
  setLoopMode: (value: 'duration' | 'count') => void;
  setLoopCount: (value: number) => void;
  setCodec: (value: string) => void;
  setAudioMode: (value: 'original' | 'normalize') => void;
  setEmbedChapters: (value: boolean) => void;
  setOutputFormat: (value: 'mp4' | 'mkv') => void;
  setSkipIntermediateOnCodecMatch: (value: boolean) => void;
}

/** Backward-compatible name used by existing consumers and test helpers. */
export type Pipeline = PipelineApi;

const PipelineContext = createContext<PipelineApi>();

export function PipelineProvider(props: {
  value: PipelineApi;
  children: JSX.Element;
}) {
  return (
    <PipelineContext.Provider value={props.value}>
      {props.children}
    </PipelineContext.Provider>
  );
}

export function usePipelineContext(): PipelineApi {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error(
      'usePipelineContext must be used within a <PipelineProvider>',
    );
  }
  return ctx;
}
