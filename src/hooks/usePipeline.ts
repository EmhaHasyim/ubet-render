import { createMemo } from 'solid-js';
import type { PipelineApi } from '../context/pipeline';
import { usePersistedConfig } from './usePersistedConfig';
import { useRenderLogs } from './useRenderLogs';
import { useResilientPeripherals } from './useResilientPeripherals';
import { useCanStart } from './useCanStart';
import { useRenderLifecycle } from './useRenderLifecycle';
import { showToast } from '../core/toast';

/**
 * Pipeline orchestrator — now a thin composer.
 *
 * Responsibility map (v0.3.0 decomposition):
 *   - `usePersistedConfig`      → persisted settings store + setters
 *   - `useRenderLogs`           → ring-buffer log store
 *   - `useResilientPeripherals` → hardware detection + drag-drop w/ fallbacks
 *   - `useCanStart`             → start-readiness validation + disabledReason
 *   - `useRenderLifecycle`      → start/pause/resume/cancel + event listener
 *
 * This hook only wires them together and exposes the {@link PipelineApi}
 * contract. Adding a config field requires one edit in `core/schema.ts` plus
 * the accessor pair below — no other orchestration changes.
 */
export function usePipeline(): PipelineApi {
  const config = usePersistedConfig();

  // Log buffer first: the peripheral fallbacks may call appendLog()
  // synchronously during hook initialisation.
  const logs = useRenderLogs();

  const { hardwareInfo, resolveEncoder, dragHover } = useResilientPeripherals(
    config,
    { appendLog: logs.appendLog },
  );

  const readiness = useCanStart(config, hardwareInfo);

  const lifecycle = useRenderLifecycle({
    config,
    logs,
    readiness,
    resolveEncoder,
  });

  const { running, paused, jobs } = lifecycle;
  const { progress } = lifecycle;

  const hasFailed = createMemo(() => jobs().some((j) => j.state === 'error'));

  return {
    running,
    paused,
    jobs,
    overallProgress: progress.overallProgress,
    overallEta: progress.overallEta,
    logs: logs.logs,
    liveStats: progress.liveStats,
    hardwareInfo,
    av1Supported: () => hardwareInfo()?.av1Supported ?? false,
    hasFailed,
    canStart: readiness.canStart,
    maxrateValid: readiness.maxrateValid,
    disabledReason: readiness.disabledReason,
    dragHover,
    startRender: lifecycle.startRender,
    resumeRender: lifecycle.resumeRender,
    cancelRender: lifecycle.cancelRender,
    pauseRender: lifecycle.pauseRender,
    /**
     * Retry a failed render from the last persisted state. Maps to
     * `startRender(true)` so the backend resumes from the on-disk state
     * file, picking up any failed jobs in the batch. Until the pipeline
     * supports per-job indices (a v0.3+ change), this is a full-batch
     * retry that only differs from a fresh run when a previous failure
     * left durable state behind.
     *
     * Surfaces a toast for the two "dead click" cases so users get
     * immediate feedback instead of a silent no-op:
     *   - another render is already running
     *   - start conditions are unmet (paths unset)
     */
    retryJob: async () => {
      if (running()) {
        showToast('A render is already in progress', {
          variant: 'info',
          ttl: 3500,
        });
        return;
      }
      if (!readiness.canStart()) {
        showToast('Cannot retry — configure sources and output first', {
          variant: 'warning',
          ttl: 4000,
        });
        return;
      }
      await lifecycle.startRender(true);
    },
    videoSource: config.videoSource,
    audioSource: config.audioSource,
    outputPath: config.outputPath,
    outputPrefix: config.outputPrefix,
    maxrate: config.maxrate,
    usePingpong: config.usePingpong,
    songsPerPlaylist: config.songsPerPlaylist,
    minDurationHours: config.minDurationHours,
    loopMode: config.loopMode,
    loopCount: config.loopCount,
    codec: config.codec,
    audioMode: config.audioMode,
    embedChapters: config.embedChapters,
    outputFormat: config.outputFormat,
    skipIntermediateOnCodecMatch: config.skipIntermediateOnCodecMatch,
    setVideoSource: config.setVideoSource,
    setAudioSource: config.setAudioSource,
    setOutputPath: config.setOutputPath,
    setOutputPrefix: config.setOutputPrefix,
    setMaxrate: config.setMaxrate,
    setUsePingpong: config.setUsePingpong,
    setSongsPerPlaylist: config.setSongsPerPlaylist,
    setMinDurationHours: config.setMinDurationHours,
    setLoopMode: config.setLoopMode,
    setLoopCount: config.setLoopCount,
    setCodec: config.setCodec,
    setAudioMode: config.setAudioMode,
    setEmbedChapters: config.setEmbedChapters,
    setOutputFormat: config.setOutputFormat,
    setSkipIntermediateOnCodecMatch: config.setSkipIntermediateOnCodecMatch,
  };
}
