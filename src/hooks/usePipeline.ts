import { createSignal, createMemo, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { JobProgress, PipelineEvent } from '../core/types';
import type { PipelineApi } from '../context/pipeline';
import { isMaxrateValid } from '../core/estimate';
import { usePersistedConfig } from './usePersistedConfig';
import { useHardware } from './useHardware';
import { useDragDrop } from './useDragDrop';
import { usePipelinePersistence } from './usePipelinePersistence';
import { createPipelineEventHandler } from './pipelineEvents';
import { showToast } from '../core/toast';
import { RingBuffer } from '../core/ringBuffer';
import { useProgressTracker } from './useProgressTracker';
import { buildAppConfig } from '../core/buildAppConfig';
import { TAURI_COMMANDS, TAURI_EVENTS } from '../core/constants';
import { createLogger } from '../core/logger';

const MAX_LOGS = 2000;

// Single namespaced logger for this hook.  Replaces 5 ad-hoc console.error
// calls — see `src/core/logger.ts`.
const log = createLogger('usePipeline');

export function usePipeline(): PipelineApi {
  const config = usePersistedConfig();

  let hardwareInfo: () => import('../hooks/useHardware').HardwareInfo | null;
  let resolveEncoder: (codec: string) => string;
  try {
    const hw = useHardware(config.codec, config.setCodec);
    hardwareInfo = hw.hardwareInfo;
    resolveEncoder = hw.resolveEncoder;
  } catch (err) {
    log.error('useHardware failed, using fallback encoder:', err);
    // Surface a warning toast so the user knows the encoder may be slower
    // (software fallback) — a silent log line is easy to miss.
    showToast('Hardware detection failed — using software fallback', {
      variant: 'warning',
      ttl: 5000,
    });
    hardwareInfo = () => null;
    resolveEncoder = (codec) => {
      if (codec === 'av1') return 'libsvtav1';
      if (codec === 'h265') return 'libx265';
      return 'libx264';
    };
  }

  let dragHover: () => 'video' | 'audio' | 'output' | null;
  try {
    dragHover = useDragDrop(
      config.setVideoSource,
      config.setAudioSource,
      config.setOutputPath,
    ).dragHover;
  } catch (err) {
    log.error('useDragDrop failed, drag-drop disabled:', err);
    showToast('Drag-and-drop is unavailable in this environment', {
      variant: 'info',
      ttl: 4000,
    });
    dragHover = () => null;
  }

  const persistence = usePipelinePersistence(config, resolveEncoder);

  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [jobs, setJobs] = createSignal<JobProgress[]>([]);
  const [logs, setLogs] = createSignal<string[]>([]);

  const progress = useProgressTracker();

  let unlisten: UnlistenFn | null = null;
  let unlistenGuard = false;
  // Reconciliation timer for {@link pauseRender}: if the backend never
  // acknowledges the pause (IPC delay / drop / webview suspend), the UI
  // would otherwise be stuck in `running=true, paused=true` indefinitely.
  // The handlePaused event handler clears this timer once the ack arrives.
  let pauseReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  const logBuffer = new RingBuffer<string>(MAX_LOGS);

  const flushLogs = () => setLogs(logBuffer.toArray());

  let logPushesSinceFlush = 0;
  const appendLog = (line: string) => {
    logBuffer.push(line);
    logPushesSinceFlush += 1;
    if (logPushesSinceFlush >= 10 || logBuffer.length === 1) {
      logPushesSinceFlush = 0;
      flushLogs();
    }
  };

  const safeUnlisten = () => {
    if (!unlistenGuard && unlisten) {
      unlistenGuard = true;
      unlisten();
      unlisten = null;
    }
  };

  const cancelPauseReconcile = (): void => {
    if (pauseReconcileTimer !== null) {
      clearTimeout(pauseReconcileTimer);
      pauseReconcileTimer = null;
    }
  };

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
      logBuffer.reset();
      setLogs([]);
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
    // Remove any stale listener from a previous render before
    // creating a new one.  Reset the guard AFTER safeUnlisten so
    // that handleDone/handleCancelled/handleFatalError can also
    // clean up once the new listener is active.
    unlistenGuard = false;
    safeUnlisten();
    unlistenGuard = false;

    try {
      unlisten = await listen<PipelineEvent>(
        TAURI_EVENTS.pipelineEvent,
        (event) => handlePipelineEvent(event.payload),
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
        // Honors the README's "Zero-Reencode Muxing" promise when source
        // codec matches target encoder.
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
      pauseReconcileTimer = setTimeout(() => {
        pauseReconcileTimer = null;
        if (running() && paused()) {
          log.warn('Pause ack timeout; reverting paused state');
          setPaused(false);
          progress.setOverallEta('Pause timeout');
          showToast('Pause timed out', { variant: 'warning', ttl: 5000 });
        }
      }, 5000);
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

  const videoSourceReady = () => {
    const v = config.videoSource();
    return (
      v !== null &&
      ((v.type === 'files' && v.paths.length > 0) ||
        (v.type === 'folder' && v.path.length > 0))
    );
  };

  const audioSourceReady = () => {
    const a = config.audioSource();
    return (
      a !== null &&
      ((a.type === 'files' && a.paths.length > 0) ||
        (a.type === 'folder' && a.path.length > 0))
    );
  };

  const outputPathReady = () => config.outputPath().length > 0;

  const pathsReady = () =>
    videoSourceReady() && audioSourceReady() && outputPathReady();

  const maxrateValid = () => isMaxrateValid(config.maxrate());

  const canStart = () => {
    const info = hardwareInfo();
    if (!pathsReady() || info === null) return false;
    if (config.codec() === 'av1' && !info.av1Supported) return false;
    return maxrateValid();
  };

  const disabledReason = createMemo(() => {
    const info = hardwareInfo();
    if (info === null) return 'Detecting hardware...';
    if (!videoSourceReady()) return 'Select a video source';
    if (!audioSourceReady()) return 'Select audio tracks';
    if (!outputPathReady()) return 'Choose an output folder';
    if (config.codec() === 'av1' && !info.av1Supported)
      return 'AV1 not supported by your hardware';
    if (!maxrateValid()) return 'Enter a valid bitrate (100–50000)';
    return '';
  });

  onCleanup(() => {
    safeUnlisten();
    cancelPauseReconcile();
  });

  return {
    running,
    paused,
    jobs,
    overallProgress: progress.overallProgress,
    overallEta: progress.overallEta,
    logs,
    liveStats: progress.liveStats,
    hardwareInfo,
    av1Supported: () => hardwareInfo()?.av1Supported ?? false,
    canStart,
    maxrateValid,
    disabledReason,
    dragHover,
    startRender,
    resumeRender,
    cancelRender,
    pauseRender,
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
     *
     * `startRender` has its own internal try/catch that converts IPC
     * failures into a sticky-error toast, so we do not wrap this call.
     * A residual outer try/catch here would be unreachable.
     */
    retryJob: async () => {
      if (running()) {
        showToast('A render is already in progress', {
          variant: 'info',
          ttl: 3500,
        });
        return;
      }
      if (!canStart()) {
        showToast('Cannot retry — configure sources and output first', {
          variant: 'warning',
          ttl: 4000,
        });
        return;
      }
      await startRender(true);
    },
    ...config,
  };
}
