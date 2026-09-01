import type { JSX } from 'solid-js';
import { PipelineProvider, type Pipeline } from '../context/pipeline';

/**
 * Create a minimal mock Pipeline for use in component tests.
 *
 * Every accessor returns a sensible default (`false` / `0` / `''` / `[]` / `null`).
 * Pass `overrides` to supply the specific values the test needs.
 */
export function createMockPipeline(overrides?: Partial<Pipeline>): Pipeline {
  const base: Record<string, unknown> = {
    running: () => false,
    paused: () => false,
    jobs: () => [],
    overallProgress: () => 0,
    overallEta: () => '',
    logs: () => [],
    liveStats: () => null,
    hardwareInfo: () => null,
    av1Supported: () => false,
    hasFailed: () => false,
    disabledReason: () => '',
    canStart: () => false,
    maxrateValid: () => true,
    dragHover: () => null,
    startRender: async () => {},
    resumeRender: async () => {},
    cancelRender: async () => {},
    pauseRender: async () => {},
    retryJob: async () => {},
    videoSource: () => null,
    audioSource: () => null,
    outputPath: () => '',
    outputPrefix: () => 'Ubet Render',
    maxrate: () => '4000k',
    usePingpong: () => true,
    songsPerPlaylist: () => 9,
    minDurationHours: () => 1,
    loopMode: () => 'duration' as const,
    loopCount: () => 1,
    codec: () => 'av1',
    audioMode: () => 'original' as const,
    embedChapters: () => true,
    outputFormat: () => 'mp4' as const,
    skipIntermediateOnCodecMatch: () => false,
    setVideoSource: () => {},
    setAudioSource: () => {},
    setOutputPath: () => {},
    setOutputPrefix: () => {},
    setMaxrate: () => {},
    setUsePingpong: () => {},
    setSongsPerPlaylist: () => {},
    setMinDurationHours: () => {},
    setLoopMode: () => {},
    setLoopCount: () => {},
    setCodec: () => {},
    setAudioMode: () => {},
    setEmbedChapters: () => {},
    setOutputFormat: () => {},
    setSkipIntermediateOnCodecMatch: () => {},
  };

  return Object.assign(base, overrides) as unknown as Pipeline;
}

/**
 * Wraps children in a PipelineProvider with a mock pipeline so components
 * that call `usePipelineContext()` can be rendered in isolation.
 *
 * Must be used as a component (not a function call) so SolidJS correctly
 * resolves the context hierarchy:
 *
 * ```tsx
 * render(() => (
 *   <WithPipeline overrides={{ ... }}>
 *     <StatsStrip />
 *   </WithPipeline>
 * ));
 * ```
 */
export function WithPipeline(props: {
  children: JSX.Element;
  overrides?: Partial<Pipeline>;
}) {
  const pipeline = createMockPipeline(props.overrides);
  return <PipelineProvider value={pipeline}>{props.children}</PipelineProvider>;
}
