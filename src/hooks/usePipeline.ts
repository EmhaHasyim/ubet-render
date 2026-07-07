import { createSignal, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { PipelineEvent, RenderJob } from '../core/types';
import { usePersistedConfig } from './usePersistedConfig';
import { useHardware } from './useHardware';
import { useDragDrop } from './useDragDrop';

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === 'granted';
    }
    if (granted) {
      await sendNotification({ title, body });
    }
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

export function usePipeline() {
  const config = usePersistedConfig();
  const { hardwareInfo, resolveEncoder } = useHardware(
    config.codec,
    config.setCodec,
  );
  const { dragHover } = useDragDrop(
    config.setVideoSource,
    config.setAudioSource,
    config.setOutputPath,
  );

  const [running, setRunning] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [jobs, setJobs] = createSignal<RenderJob[]>([]);
  const [overallProgress, setOverallProgress] = createSignal(0);
  const [overallEta, setOverallEta] = createSignal<string>('');
  const [logs, setLogs] = createSignal<string[]>([]);
  let unlisten: UnlistenFn | null = null;
  let unlistenGuard = false;
  let startProgress = 0;

  // Ring buffer for ETA samples — pre-allocated, no slice() allocations
  const MAX_ETA_SAMPLES = 10;
  const etaRing: { elapsed: number; gained: number }[] = Array.from({ length: MAX_ETA_SAMPLES });
  let etaIndex = 0;
  let etaCount = 0;

  // Ring buffer for logs — pre-allocated, no spread/slice allocations on append
  const MAX_LOG = 2000;
  const logBuffer: string[] = Array.from({ length: MAX_LOG });
  let logIndex = 0;
  let logCount = 0;

  // Rebuild the signal array from the ring buffer (only done once per batch, not per append)
  const flushLogs = () => {
    if (logCount < MAX_LOG) {
      // Not yet wrapped — simple slice
      setLogs(logBuffer.slice(0, logCount));
    } else {
      // Wrapped — concatenate the two segments
      setLogs([...logBuffer.slice(logIndex), ...logBuffer.slice(0, logIndex)]);
    }
  };

  const safeUnlisten = () => {
    if (!unlistenGuard && unlisten) {
      unlistenGuard = true;
      unlisten();
      unlisten = null;
    }
  };

  const appendLog = (line: string) => {
    logBuffer[logIndex] = line;
    logIndex = (logIndex + 1) % MAX_LOG;
    logCount = Math.min(logCount + 1, MAX_LOG);
    // Periodically flush to the signal so the UI updates.
    // Flush every 10 entries to batch updates and avoid per-line allocations.
    if (logIndex % 10 === 0 || logCount === 1) {
      flushLogs();
    }
  };

  const pathsReady = () => {
    const v = config.videoSource();
    const a = config.audioSource();
    const o = config.outputPath();
    const videoOk = v !== null && v.type === 'files' && v.paths.length > 0;
    const audioOk = a !== null && a.type === 'files' && a.paths.length > 0;
    const outputOk = o.length > 0;
    return videoOk && audioOk && outputOk;
  };

  const canStart = () => {
    const info = hardwareInfo();
    if (!pathsReady() || info === null) return false;
    return config.codec() !== 'av1' || info.av1Supported;
  };

  const startRender = async (resume: boolean = false) => {
    if (running() || (!resume && !canStart())) return;

    // Validate bitrate BEFORE setting up anything, so we fail fast
    if (!/^\d+k$/.test(config.maxrate())) {
      appendLog(`[WARN] Bitrate '${config.maxrate()}' tidak valid. Gunakan format seperti '4000k' (angka + huruf k).`);
      return;
    }

    setRunning(true);
    setPaused(false);
    if (!resume) {
      setJobs([]);
      // Reset log ring buffer
      logIndex = 0;
      logCount = 0;
      setLogs([]);
      setOverallProgress(0);
      setOverallEta('Menghitung...');
      startProgress = 0;
    } else {
      setOverallEta('Melanjutkan...');
      startProgress = overallProgress();
    }

    let startTime = Date.now();
    // Reset ETA ring buffer
    etaIndex = 0;
    etaCount = 0;
    unlistenGuard = false;
    safeUnlisten();

    try {
      unlisten = await listen<PipelineEvent>('pipeline-event', (event) => {
        const payload = event.payload;
        switch (payload.type) {
          case 'Log':
            appendLog(
              `[${payload.data.level.toUpperCase()}] ${payload.data.message}`,
            );
            break;
          case 'Progress':
            setJobs(payload.data.jobs);
            const totalJobs = payload.data.total;
            const jobsProgressSum = payload.data.jobs.reduce(
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
              // Ring buffer insert — no allocation
              etaRing[etaIndex] = { elapsed: elapsedMs, gained: progressGained };
              etaIndex = (etaIndex + 1) % MAX_ETA_SAMPLES;
              etaCount = Math.min(etaCount + 1, MAX_ETA_SAMPLES);

              // Compute average over ring buffer entries
              const count = Math.min(etaCount, MAX_ETA_SAMPLES);
              let sumRate = 0;
              for (let i = 0; i < count; i++) {
                const s = etaRing[i];
                sumRate += s.gained / s.elapsed;
              }
              const avgRate = sumRate / count;
              if (avgRate > 0) {
                const remainingMs = (100 - overallPercent) / avgRate;
                if (remainingMs > 0 && remainingMs < 86400000) {
                  const s = Math.floor((remainingMs / 1000) % 60);
                  const m = Math.floor((remainingMs / (1000 * 60)) % 60);
                  const h = Math.floor(remainingMs / (1000 * 60 * 60));
                  setOverallEta(`${h > 0 ? h + 'j ' : ''}${m}m ${s}s tersisa`);
                }
              }
            } else if (overallPercent >= 100) {
              setOverallEta('Selesai');
            }
            break;
          case 'Done':
            setRunning(false);
            setPaused(false);
            setOverallProgress(100);
            setOverallEta(
              payload.data.failed > 0 ? 'Selesai dengan error' : 'Selesai',
            );
            safeUnlisten();
            notify(
              payload.data.failed > 0
                ? 'Render selesai dengan error'
                : 'Render selesai',
              `${payload.data.completed}/${payload.data.total} selesai, ${payload.data.failed} gagal.`,
            );
            break;
          case 'Paused':
            appendLog('[INFO] Render dijeda');
            setRunning(false);
            setPaused(true);
            setOverallEta('Dijeda');
            // Do NOT call safeUnlisten() here — keep the listener alive so we can
            // still receive Cancelled, FatalError, or a Done event if the pipeline
            // terminates after pause. On resume, safeUnlisten() is called at the
            // top of startRender() which will remove this listener before creating a new one.
            notify('Render dijeda', 'Render sedang dijeda.');
            break;
          case 'Cancelled':
            appendLog(`[INFO] ${payload.data}`);
            setRunning(false);
            setPaused(false);
            setOverallEta('Render dibatalkan');
            safeUnlisten();
            break;
          case 'FatalError':
            appendLog(`FATAL: ${payload.data}`);
            setRunning(false);
            setPaused(false);
            setOverallEta('Gagal');
            safeUnlisten();
            notify('Render gagal', `Error: ${payload.data}`);
            break;
        }
      });

      const encoder = resolveEncoder(config.codec());

      const overrides = {
        videoSource: config.videoSource(),
        audioSource: config.audioSource(),
        outputPath: config.outputPath(),
        songsPerPlaylist: config.songsPerPlaylist(),
        minDurationHours: config.loopMode() === 'count' ? null : config.minDurationHours(),
        encoder,
        outputPrefix: config.outputPrefix(),
        maxrate: config.maxrate(),
        usePingpong: config.usePingpong(),
        youtubeTimestamps: config.youtubeTimestamps(),
        maxConcurrentJobs: config.maxConcurrentJobs(),
        watermarkPath: config.watermarkPath(),
        watermarkOpacity: config.watermarkOpacity(),
        loopCount: config.loopMode() === 'count' ? config.loopCount() : null,
      };

      await invoke('start_render', {
        overrides,
        resume,
      });
    } catch (err) {
      safeUnlisten();
      appendLog(`Error: ${String(err)}`);
      setRunning(false);
      setPaused(false);
      setOverallEta('Gagal');
    }
  };

  const resumeRender = async () => {
    if (!paused()) return;
    // First try to resume the existing pipeline via the resume_render command
    try {
      await invoke('resume_render');
      setPaused(false);
      setRunning(true);
      setOverallEta('Melanjutkan...');
    } catch {
      // If resume_render fails (e.g., old pipeline already terminated),
      // fall back to starting a new pipeline with resume=true
      await startRender(true);
    }
  };

  const cancelRender = async () => {
    try {
      await invoke('cancel_render');
    } catch (err) {
      console.error('Cancel render failed:', err);
      appendLog(`Error: Failed to cancel render - ${String(err)}`);
    }
  };

  const pauseRender = async () => {
    try {
      setPaused(true);
      setOverallEta('Menjeda...');
      await invoke('pause_render');
    } catch (err) {
      console.error('Pause render failed:', err);
      appendLog(`Error: Failed to pause render - ${String(err)}`);
      setPaused(false);
    }
  };

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
    hardwareInfo,
    av1Supported: () => hardwareInfo()?.av1Supported ?? false,
    pathsReady,
    canStart,
    dragHover,
    startRender,
    resumeRender,
    cancelRender,
    pauseRender,
    ...config,
  };
}
