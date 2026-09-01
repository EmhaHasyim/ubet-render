import { createSignal, onCleanup, type Accessor, type Setter } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JobProgress, PipelineEvent } from '../core/types';
import { isMaxrateValid } from '../core/estimate';
import { usePipelinePersistence } from './usePipelinePersistence';
import { createPipelineEventHandler } from './pipelineEvents';
import { useProgressTracker } from './useProgressTracker';
import { buildAppConfig } from '../core/buildAppConfig';
import { TAURI_COMMANDS, TAURI_EVENTS } from '../core/constants';
import { createLogger } from '../core/logger';
import { showToast } from '../core/toast';
import { createRenderLifecycleResources } from './renderLifecycleResources';
import type { useRenderLogs } from './useRenderLogs';
import type { useCanStart } from './useCanStart';
import type { BackendConfigSnapshot } from '../core/buildAppConfig';

const log = createLogger('usePipeline');

/** Pause-ack reconciliation window (ms) — see pauseRender. */
const PAUSE_ACK_TIMEOUT_MS = 5000;

interface LifecycleConfig {
  maxrate: Accessor<string>;
  codec: Accessor<string>;
  videoSource: Accessor<unknown>;
  audioSource: Accessor<unknown>;
  outputPath: Accessor<string>;
  outputPrefix: Accessor<string>;
  songsPerPlaylist: Accessor<number>;
  minDurationHours: Accessor<number>;
  loopMode: Accessor<'duration' | 'count'>;
  loopCount: Accessor<number>;
  usePingpong: Accessor<boolean>;
  audioMode: Accessor<'original' | 'normalize'>;
  embedChapters: Accessor<boolean>;
  outputFormat: Accessor<'mp4' | 'mkv'>;
  skipIntermediateOnCodecMatch: Accessor<boolean>;
}

interface LifecycleDeps {
  config: LifecycleConfig & BackendConfigSnapshot;
  logs: ReturnType<typeof useRenderLogs>;
  readiness: ReturnType<typeof useCanStart>;
  resolveEncoder: (codec: string) => string;
}

/**
 * Render lifecycle: start / pause / resume / cancel / retry, ownership of
 * the pipeline event listener, and the pause-ack reconciliation timer.
 * Pure orchestration — state signals live here, validation lives in
 * {@link useCanStart}, logs in {@link useRenderLogs}.
 */
export function useRenderLifecycle({
  config,
  logs,
  readiness,
  resolveEncoder,
}: LifecycleDeps) {
  const { appendLog, reset: resetLogs } = logs;
  const { canStart } = readiness;

  const persistence = usePipelinePersistence(config, resolveEncoder);

  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [jobs, setJobs] = createSignal<JobProgress[]>([]);

  const progress = useProgressTracker();

  const resources = createRenderLifecycleResources();
  const { safeUnlisten, cancelPauseReconcile } = resources;

  const handlePipelineEvent = createPipelineEventHandler({
    cancelPauseReconcile,
    appendLog,
    safeUnlisten,
    setRunning,
    setPaused,
    setJobs,
    setOverallProgress: progress.setOverallProgress,
    setOverallEta: progress.setOverallEta,
    setLiveStats: progress.setLiveStats,
    getStartProgress: progress.getStartProgress,
    setStartProgress: progress.setStartProgress,
    getStartTime: progress.getStartTime,
    etaCalculator: progress.etaCalculator,
  });

  const resetRenderState = (resuming: boolean) => {
    setRunning(true);
    setPaused(false);
    progress.resetProgress(resuming);
    if (!resuming) {
      setJobs([]);
      resetLogs();
    }
  };

  const startRender = async (resume: boolean = false) => {
    if (running() || (!resume && !canStart())) return;

    if (!isMaxrateValid(config.maxrate())) {
      appendLog(
        `[WARN] Bitrate '${config.maxrate()}' is invalid. Enter a number between 100 and 50000.`,
      );
      showToast('Enter a valid bitrate between 100 and 50000', {
        variant: 'warning',
        ttl: 4000,
      });
      return;
    }

    // Do not start a render against a stale backend snapshot. Persistence is
    // retried internally, and a failed final flush leaves the UI untouched so
    // the user can retry instead of silently rendering with old settings.
    if (!(await persistence.flush())) {
      appendLog('Error: Settings could not be saved; render was not started.');
      return;
    }

    resetRenderState(resume);
    // Remove any stale listener from a previous render before creating a new one.
    safeUnlisten();

    try {
      resources.setListener(
        await listen<PipelineEvent>(TAURI_EVENTS.pipelineEvent, (event) =>
          handlePipelineEvent(event.payload),
        ),
      );

      const encoder = resolveEncoder(config.codec());

      const overrides = {
        videoSource: config.videoSource(),
        audioSource: config.audioSource(),
        outputPath: config.outputPath(),
        songsPerPlaylist: config.songsPerPlaylist(),
        minDurationHours:
          config.loopMode() === 'count' ? null : config.minDurationHours(),
        encoder,
        outputPrefix: config.outputPrefix(),
        maxrate: config.maxrate(),
        usePingpong: config.usePingpong(),
        audioMode: config.audioMode(),
        embedChapters: config.embedChapters(),
        outputFormat: config.outputFormat(),
        loopCount: config.loopMode() === 'count' ? config.loopCount() : null,
        skipIntermediateOnCodecMatch: config.skipIntermediateOnCodecMatch(),
      };

      await invoke(TAURI_COMMANDS.startRender, {
        config: buildAppConfig(config, resolveEncoder),
        overrides,
        resume,
      });
    } catch (err) {
      safeUnlisten();
      appendLog(`Error: ${String(err)}`);
      setRunning(false);
      setPaused(false);
      progress.setOverallEta('Failed');
      showToast('Render failed to start', { variant: 'error', ttl: 0 });
    }
  };

  const resumeRender = async () => {
    if (!paused()) return;
    try {
      const resumed = await invoke<boolean>(TAURI_COMMANDS.resumeRender);
      if (resumed) {
        setPaused(false);
        setRunning(true);
        progress.setOverallEta('Resuming...');
        // Real resume (backend confirmed a live pipeline): the UI keeps its
        // pre-pause signals, so seed the ETA baseline here — the same sentinel
        // `resetRenderState(true)` uses for the restart path.
        progress.seedResumeBaseline();
      } else {
        // Pipeline already terminated; start a fresh one from state file.
        setPaused(false);
        await startRender(true);
      }
    } catch {
      // IPC failed entirely — reset paused state so the UI doesn't
      // stay frozen, then attempt a clean restart.
      setPaused(false);
      await startRender(true);
    }
  };

  const cancelRender = async () => {
    cancelPauseReconcile();
    progress.setOverallEta('Cancelling...');
    try {
      const accepted = await invoke<boolean>(TAURI_COMMANDS.cancelRender);
      if (accepted) {
        // The backend command waits for the render task and its guard to
        // terminate before returning true. This is a completion acknowledgement
        // rather than a request acknowledgement, so the local lifecycle can
        // finish safely even if the terminal event is delayed or lost.
        setRunning(false);
        setPaused(false);
        progress.setOverallEta('Render cancelled');
        safeUnlisten();
      } else {
        // No backend pipeline exists anymore, so there will be no terminal
        // event to wait for. Finish the local lifecycle immediately.
        setRunning(false);
        setPaused(false);
        progress.setOverallEta('Render cancelled');
        safeUnlisten();
      }
    } catch (err) {
      // A failed command did not prove that the backend stopped. Keep the
      // listener and the running state so a late terminal event remains
      // observable; the user can retry cancellation.
      log.error('Cancel render failed:', err);
      appendLog(`Error: Failed to cancel render - ${String(err)}`);
      progress.setOverallEta('Cancel failed');
      showToast('Cancel request failed — render may still be running', {
        variant: 'warning',
        ttl: 5000,
      });
    }
  };

  const pauseRender = async () => {
    cancelPauseReconcile();
    try {
      setPaused(true);
      progress.setOverallEta('Pausing...');

      // If the backend never acknowledges the pause (e.g. webview suspended,
      // IPC dropped), auto-reconcile the UI back to "running" after 5s so the
      // user is not stranded in a half-paused state. handlePaused cancels
      // this timer the moment the ack arrives.
      resources.schedulePauseReconcile(() => {
        if (running() && paused()) {
          log.warn('Pause ack timeout; reverting paused state');
          appendLog(
            '[WARN] Pause request timed out — the render may still be running',
          );
          setPaused(false);
          progress.setOverallEta('Pause timeout');
          showToast('Pause timed out', { variant: 'warning', ttl: 5000 });
        }
      }, PAUSE_ACK_TIMEOUT_MS);
      await invoke(TAURI_COMMANDS.pauseRender);
    } catch (err) {
      cancelPauseReconcile();
      log.error('Pause render failed:', err);
      appendLog(`Error: Failed to pause render - ${String(err)}`);
      setPaused(false);
      progress.setOverallEta('Failed');
      showToast('Pause failed', { variant: 'error', ttl: 4000 });
    }
  };

  onCleanup(() => {
    resources.dispose();
  });

  return {
    running,
    paused,
    setRunning: setRunning as Setter<boolean>,
    setPaused: setPaused as Setter<boolean>,
    jobs,
    setJobs,
    progress,
    startRender,
    resumeRender,
    cancelRender,
    pauseRender,
  };
}
