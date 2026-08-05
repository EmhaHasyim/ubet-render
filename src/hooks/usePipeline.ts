import { createSignal, createMemo, createEffect, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  JobProgress,
  PipelineEvent,
  PipelineProgress,
} from '../core/types';
import { isMaxrateValid } from '../core/estimate';
import { usePersistedConfig } from './usePersistedConfig';
import { useHardware } from './useHardware';
import { useDragDrop } from './useDragDrop';
import { notify } from '../core/notify';
import { showToast } from '../core/toast';
import { RingBuffer } from '../core/ringBuffer';
import { EtaCalculator } from '../core/eta';
import { buildAppConfig } from '../core/buildAppConfig';
import { TAURI_COMMANDS, TAURI_EVENTS } from '../core/constants';
import { createLogger } from '../core/logger';

const MAX_LOGS = 2000;
const MAX_ETA_SAMPLES = 10;

// Single namespaced logger for this hook.  Replaces 5 ad-hoc console.error
// calls — see `src/core/logger.ts`.
const log = createLogger('usePipeline');

export function usePipeline() {
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

  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [jobs, setJobs] = createSignal<JobProgress[]>([]);
  const [overallProgress, setOverallProgress] = createSignal(0);
  const [overallEta, setOverallEta] = createSignal<string>('');
  const [logs, setLogs] = createSignal<string[]>([]);
  const [liveStats, setLiveStats] = createSignal<{
    speed: number;
    bitrateKbps: number;
    fps: number;
  } | null>(null);

  let unlisten: UnlistenFn | null = null;
  let unlistenGuard = false;
  let startProgress = 0;
  let startTime = 0;
  // Reconciliation timer for {@link pauseRender}: if the backend never
  // acknowledges the pause (IPC delay / drop / webview suspend), the UI
  // would otherwise be stuck in `running=true, paused=true` indefinitely.
  // The handlePaused event handler clears this timer once the ack arrives.
  let pauseReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  // Reconciliation timer for {@link resumeRender}: a pause is implemented by
  // the backend as a soft-kill (ffmpeg stopped, state saved, pipeline task
  // unwinds). If the user resumes while the old task is still tearing down,
  // the backend can answer `true` even though no pipeline is actually coming
  // back — leaving the UI stuck in `running=true` forever with no pipeline
  // activity. This watchdog restarts from the saved state if no real
  // pipeline activity (Progress/Stats) arrives shortly after a "resumed" ack.
  let resumeReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  const logBuffer = new RingBuffer<string>(MAX_LOGS);
  const etaCalculator = new EtaCalculator(MAX_ETA_SAMPLES);

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

  /**
   * Fresh ETA baseline for a resumed render. The backend resumes from the
   * *saved* state file, whose progress can differ from the last value the UI
   * saw (state is saved every ~2s while progress events are throttled to
   * 120ms). A stale baseline would make the first post-resume Progress event
   * look like a huge burst of work (bogus near-zero ETA), and the pause idle
   * time must not count as render time. Seed a sentinel so the first
   * post-resume Progress event establishes the real baseline before any
   * sample is taken.
   */
  const seedResumeBaseline = () => {
    startProgress = -1;
    startTime = Date.now();
    etaCalculator.reset();
  };

  const resetRenderState = (resuming: boolean) => {
    setRunning(true);
    setPaused(false);
    setLiveStats(null);
    if (!resuming) {
      setJobs([]);
      logBuffer.reset();
      setLogs([]);
      setOverallProgress(0);
      setOverallEta('Calculating...');
      startProgress = 0;
      etaCalculator.reset();
    } else {
      setOverallEta('Resuming...');
      seedResumeBaseline();
    }
    startTime = Date.now();
  };

  const handleProgress = (data: PipelineProgress) => {
    // Real pipeline activity — a resumed pipeline is alive; disarm the
    // resume watchdog.
    cancelResumeReconcile();
    setJobs(data.jobs);
    const totalJobs = data.total;
    const jobsProgressSum = data.jobs.reduce(
      (sum, j) => sum + j.progressPercent,
      0,
    );
    const overallPercent =
      totalJobs > 0
        ? Math.min(100, Math.max(0, jobsProgressSum / totalJobs))
        : 0;
    setOverallProgress(overallPercent);

    if (startProgress < 0) {
      // First Progress event after a resume: use the actual (possibly more
      // advanced) pipeline state as the ETA baseline instead of the stale
      // pre-pause UI value, and skip sampling this event.
      startProgress = overallPercent;
      if (overallPercent >= 100) {
        // A first event at 100% means the resumed batch is already done —
        // report Done here so a lost Done event can't leave the ETA
        // hanging on "Resuming...".
        setOverallEta('Done');
      }
    } else {
      const progressGained = overallPercent - startProgress;
      if (progressGained > 0.001 && overallPercent < 100) {
        const elapsedMs = Date.now() - startTime;
        etaCalculator.addSample(elapsedMs, progressGained);
        setOverallEta(etaCalculator.estimateRemaining(overallPercent));
      } else if (overallPercent >= 100) {
        setOverallEta('Done');
      }
    }
  };

  const handleDone = (data: {
    completed: number;
    total: number;
    failed: number;
  }) => {
    cancelResumeReconcile();
    setRunning(false);
    setPaused(false);
    setOverallProgress(100);
    setOverallEta(data.failed > 0 ? 'Finished with errors' : 'Done');
    safeUnlisten();
    notify(
      data.failed > 0 ? 'Render finished with errors' : 'Render finished',
      `${data.completed}/${data.total} done, ${data.failed} failed.`,
    );
    // Companion in-app toast: this fires for both minimised-to-tray and
    // window-visible scenarios, complementing the OS-level notification.
    // Distinct variant picks (success vs. warning) reinforce the result.
    showToast(
      data.failed > 0
        ? `Render finished with ${data.failed} error${data.failed === 1 ? '' : 's'}`
        : 'Render finished',
      {
        variant: data.failed > 0 ? 'warning' : 'success',
        ttl: 4500,
      },
    );
  };

  const handlePaused = () => {
    // Backend acknowledged the pause \u2014 cancel the reconciliation timer.
    if (pauseReconcileTimer !== null) {
      clearTimeout(pauseReconcileTimer);
      pauseReconcileTimer = null;
    }
    // We're paused again — any pending resume watchdog is moot.
    cancelResumeReconcile();
    appendLog('[INFO] Render paused');
    setRunning(false);
    setPaused(true);
    setOverallEta('Paused');
    // Use the in-app toast only; the OS notification was removed in
    // v0.2.3 because we don't know whether the user has the window
    // visible or minimised to the tray when pause is acked, and a
    // double-notify is noisy.
    showToast('Render paused', { variant: 'info', ttl: 2500 });
  };

  const handleCancelled = (message: string) => {
    cancelResumeReconcile();
    appendLog(`[INFO] ${message}`);
    setRunning(false);
    setPaused(false);
    setOverallEta('Render cancelled');
    safeUnlisten();
  };

  const handleFatalError = (message: string) => {
    cancelResumeReconcile();
    appendLog(`FATAL: ${message}`);
    setRunning(false);
    setPaused(false);
    setOverallEta('Failed');
    safeUnlisten();
    notify('Render failed', `Error: ${message}`);
    // In-app toast mirrors the OS notification with a sticky error that
    // requires explicit dismissal — fatal errors deserve user's attention.
    showToast(`Render failed: ${message}`, { variant: 'error', ttl: 0 });
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

    resetRenderState(resume);
    // Starting a fresh render invalidates any pending resume watchdog.
    cancelResumeReconcile();
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
        (event) => {
          const payload = event.payload;
          switch (payload.type) {
            case 'Log':
              appendLog(
                `[${payload.data.level.toUpperCase()}] ${payload.data.message}`,
              );
              break;
            case 'Stats':
              // Live encoder stats are real pipeline activity too — disarm
              // the resume watchdog just like Progress events do.
              cancelResumeReconcile();
              setLiveStats(payload.data);
              break;
            case 'Progress':
              handleProgress(payload.data);
              break;
            case 'Done':
              handleDone(payload.data);
              break;
            case 'Paused':
              handlePaused();
              break;
            case 'Cancelled':
              handleCancelled(payload.data);
              break;
            case 'FatalError':
              handleFatalError(payload.data);
              break;
          }
        },
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
      setOverallEta('Failed');
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
        setOverallEta('Resuming...');
        // Real resume (backend confirmed a live pipeline): the UI keeps its
        // pre-pause signals, so seed the ETA baseline here — the same sentinel
        // `resetRenderState(true)` uses for the restart path.
        seedResumeBaseline();
        // Watchdog for the pause→quick-resume race: the backend may answer
        // `true` while the old pipeline is still tearing down. If no real
        // activity (Progress/Stats) arrives within the window, assume the
        // pipeline died and restart from the saved state file instead of
        // leaving the UI stuck in "Rendering" forever.
        cancelResumeReconcile();
        resumeReconcileTimer = setTimeout(async () => {
          resumeReconcileTimer = null;
          if (running() && !paused()) {
            log.warn(
              'Resume watchdog: no pipeline activity; restarting from saved state',
            );
            safeUnlisten();
            setRunning(false);
            await startRender(true);
          }
        }, 6000);
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
    // Disarm the resume watchdog too: if the user pauses → resumes → cancels
    // quickly, `safeUnlisten()` in the `finally` below removes the listener,
    // so the backend's Cancelled event may never reach `handleCancelled`.
    // Without this, the watchdog would fire 6s later and restart the very
    // render the user just cancelled.
    cancelResumeReconcile();
    try {
      await invoke(TAURI_COMMANDS.cancelRender);
    } catch (err) {
      log.error('Cancel render failed:', err);
      appendLog(`Error: Failed to cancel render - ${String(err)}`);
    } finally {
      // Always release the Tauri event listener so it doesn't linger
      // when the backend's Cancelled event never reaches the frontend
      // (e.g. IPC channel dropped, Tauri webview suspended, etc.).
      safeUnlisten();
    }
  };

  const cancelPauseReconcile = (): void => {
    if (pauseReconcileTimer !== null) {
      clearTimeout(pauseReconcileTimer);
      pauseReconcileTimer = null;
    }
  };

  const cancelResumeReconcile = (): void => {
    if (resumeReconcileTimer !== null) {
      clearTimeout(resumeReconcileTimer);
      resumeReconcileTimer = null;
    }
  };

  const pauseRender = async () => {
    cancelPauseReconcile();
    try {
      setPaused(true);
      setOverallEta('Pausing...');
      // If the backend never acknowledges the pause (e.g. webview suspended,
      // IPC dropped), auto-reconcile the UI back to "running" after 5s so the
      // user is not stranded in a half-paused state. handlePaused cancels
      // this timer the moment the ack arrives.
      pauseReconcileTimer = setTimeout(() => {
        pauseReconcileTimer = null;
        if (running() && paused()) {
          log.warn('Pause ack timeout; reverting paused state');
          setPaused(false);
          setOverallEta('Pause timeout');
          showToast('Pause timed out', { variant: 'warning', ttl: 5000 });
        }
      }, 5000);
      await invoke(TAURI_COMMANDS.pauseRender);
    } catch (err) {
      cancelPauseReconcile();
      log.error('Pause render failed:', err);
      appendLog(`Error: Failed to pause render - ${String(err)}`);
      setPaused(false);
      setOverallEta('Failed');
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

  // Debounced save — persist config to backend whenever the user changes any
  // setting, so the backend's validation can surface errors early and the
  // persisted config file stays in sync with the front-end.
  //
  // The `void [...]` expression intentionally throws away the values; its
  // sole purpose is to register each of the eight config fields as a
  // SolidJS reactive dependency inside this effect's scope, so the
  // effect re-runs whenever any of them changes.
  createEffect(() => {
    void [
      config.codec(),
      config.maxrate(),
      config.songsPerPlaylist(),
      config.minDurationHours(),
      config.outputPrefix(),
      config.outputPath(),
      config.embedChapters(),
      config.audioMode(),
    ];

    const timer = setTimeout(async () => {
      try {
        await invoke(TAURI_COMMANDS.saveConfig, {
          config: buildAppConfig(config, resolveEncoder),
        });
      } catch (err) {
        log.error('Failed to save backend config:', err);
        // Best-effort info-level toast — debounced failures can stack up
        // during normal use so the variant is muted (info) and ttl short.
        showToast('Settings could not be saved to disk', {
          variant: 'info',
          ttl: 3500,
        });
      }
    }, 500);

    onCleanup(() => clearTimeout(timer));
  });

  onCleanup(() => {
    safeUnlisten();
    cancelPauseReconcile();
    cancelResumeReconcile();
  });

  return {
    running,
    paused,
    jobs,
    overallProgress,
    overallEta,
    logs,
    liveStats,
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
