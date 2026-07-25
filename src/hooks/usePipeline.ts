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
import { RingBuffer } from '../core/ringBuffer';
import { EtaCalculator } from '../core/eta';
import { buildAppConfig } from '../core/buildAppConfig';
import { TAURI_COMMANDS, TAURI_EVENTS } from '../core/constants';

const MAX_LOGS = 2000;
const MAX_ETA_SAMPLES = 10;

export function usePipeline() {
  const config = usePersistedConfig();

  let hardwareInfo: () => import('../hooks/useHardware').HardwareInfo | null;
  let resolveEncoder: (codec: string) => string;
  try {
    const hw = useHardware(config.codec, config.setCodec);
    hardwareInfo = hw.hardwareInfo;
    resolveEncoder = hw.resolveEncoder;
  } catch (err) {
    console.error(
      '[usePipeline] useHardware failed, using fallback encoder:',
      err,
    );
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
    console.error('[usePipeline] useDragDrop failed, drag-drop disabled:', err);
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
      startProgress = overallProgress();
    }
    startTime = Date.now();
  };

  const handleProgress = (data: PipelineProgress) => {
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

    const progressGained = overallPercent - startProgress;
    if (progressGained > 0.001 && overallPercent < 100) {
      const elapsedMs = Date.now() - startTime;
      etaCalculator.addSample(elapsedMs, progressGained);
      setOverallEta(etaCalculator.estimateRemaining(overallPercent));
    } else if (overallPercent >= 100) {
      setOverallEta('Done');
    }
  };

  const handleDone = (data: {
    completed: number;
    total: number;
    failed: number;
  }) => {
    setRunning(false);
    setPaused(false);
    setOverallProgress(100);
    setOverallEta(data.failed > 0 ? 'Finished with errors' : 'Done');
    safeUnlisten();
    notify(
      data.failed > 0 ? 'Render finished with errors' : 'Render finished',
      `${data.completed}/${data.total} done, ${data.failed} failed.`,
    );
  };

  const handlePaused = () => {
    appendLog('[INFO] Render paused');
    setRunning(false);
    setPaused(true);
    setOverallEta('Paused');
    notify('Render paused', 'Render is paused.');
  };

  const handleCancelled = (message: string) => {
    appendLog(`[INFO] ${message}`);
    setRunning(false);
    setPaused(false);
    setOverallEta('Render cancelled');
    safeUnlisten();
  };

  const handleFatalError = (message: string) => {
    appendLog(`FATAL: ${message}`);
    setRunning(false);
    setPaused(false);
    setOverallEta('Failed');
    safeUnlisten();
    notify('Render failed', `Error: ${message}`);
  };

  const startRender = async (resume: boolean = false) => {
    if (running() || (!resume && !canStart())) return;

    if (!isMaxrateValid(config.maxrate())) {
      appendLog(
        `[WARN] Bitrate '${config.maxrate()}' is invalid. Enter a number between 100 and 50000.`,
      );
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
        (event) => {
          const payload = event.payload;
          switch (payload.type) {
            case 'Log':
              appendLog(
                `[${payload.data.level.toUpperCase()}] ${payload.data.message}`,
              );
              break;
            case 'Stats':
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
    try {
      await invoke(TAURI_COMMANDS.cancelRender);
    } catch (err) {
      console.error('Cancel render failed:', err);
      appendLog(`Error: Failed to cancel render - ${String(err)}`);
    } finally {
      // Always release the Tauri event listener so it doesn't linger
      // when the backend's Cancelled event never reaches the frontend
      // (e.g. IPC channel dropped, Tauri webview suspended, etc.).
      safeUnlisten();
    }
  };

  const pauseRender = async () => {
    try {
      setPaused(true);
      setOverallEta('Pausing...');
      await invoke(TAURI_COMMANDS.pauseRender);
    } catch (err) {
      console.error('Pause render failed:', err);
      appendLog(`Error: Failed to pause render - ${String(err)}`);
      setPaused(false);
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
  createEffect(() => {
    const _deps = [
      config.codec(),
      config.maxrate(),
      config.songsPerPlaylist(),
      config.minDurationHours(),
      config.outputPrefix(),
      config.outputPath(),
      config.embedChapters(),
      config.audioMode(),
    ];
    void _deps;

    const timer = setTimeout(async () => {
      try {
        await invoke(TAURI_COMMANDS.saveConfig, {
          config: buildAppConfig(config, resolveEncoder),
        });
      } catch (err) {
        console.error('Failed to save backend config:', err);
      }
    }, 500);

    onCleanup(() => clearTimeout(timer));
  });

  onCleanup(() => {
    safeUnlisten();
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
    ...config,
  };
}
