import { createSignal, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { DEFAULT_CONFIG } from '../core/config';
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
      sendNotification({ title, body });
    }
  } catch {}
}

export function usePipeline() {
  const [running, setRunning] = createSignal(false);
  const [jobs, setJobs] = createSignal<RenderJob[]>([]);
  const [overallProgress, setOverallProgress] = createSignal(0);
  const [overallEta, setOverallEta] = createSignal<string>('');
  const [logs, setLogs] = createSignal<string[]>([]);

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

  let unlisten: UnlistenFn | null = null;

  const appendLog = (line: string) => {
    setLogs((prev) => {
      const updated = [...prev, line];
      return updated.length > 500 ? updated.slice(-500) : updated;
    });
  };

  const pathsReady = () => {
    const v = config.videoSource();
    const a = config.audioSource();
    const o = config.outputPath();
    const videoOk = v !== null && v.paths.length > 0;
    const audioOk = a !== null && a.paths.length > 0;
    const outputOk = o.length > 0;
    return videoOk && audioOk && outputOk;
  };

  const canStart = () => {
    const info = hardwareInfo();
    if (!pathsReady() || info === null) return false;
    return config.codec() !== 'av1' || info.av1Supported;
  };

  const startRender = async () => {
    if (running() || !canStart()) return;
    setRunning(true);
    setJobs([]);
    setLogs([]);
    setOverallProgress(0);
    setOverallEta('Menghitung...');

    let startTime = Date.now();

    if (unlisten) {
      unlisten();
      unlisten = null;
    }

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
            const overallPct =
              totalJobs > 0
                ? Math.min(100, Math.max(0, jobsProgressSum / totalJobs))
                : 0;
            setOverallProgress(overallPct);

            if (overallPct > 0 && overallPct < 100) {
              const elapsedMs = Date.now() - startTime;
              const estimatedTotalMs = elapsedMs / (overallPct / 100);
              const remainingMs = estimatedTotalMs - elapsedMs;
              if (remainingMs > 0) {
                const s = Math.floor((remainingMs / 1000) % 60);
                const m = Math.floor((remainingMs / (1000 * 60)) % 60);
                const h = Math.floor(remainingMs / (1000 * 60 * 60));
                setOverallEta(`${h > 0 ? h + 'j ' : ''}${m}m ${s}s tersisa`);
              }
            } else if (overallPct === 100) {
              setOverallEta('Selesai');
            }
            break;
          case 'Done':
            setRunning(false);
            setOverallProgress(100);
            setOverallEta(
              payload.data.failed > 0 ? 'Selesai dengan error' : 'Selesai',
            );
            if (unlisten) {
              unlisten();
              unlisten = null;
            }
            notify(
              payload.data.failed > 0
                ? 'Render selesai dengan error'
                : 'Render selesai',
              `${payload.data.completed}/${payload.data.total} selesai, ${payload.data.failed} gagal.`,
            );
            break;
          case 'Cancelled':
            appendLog(`[INFO] ${payload.data}`);
            setRunning(false);
            setOverallEta('Dibatalkan');
            if (unlisten) {
              unlisten();
              unlisten = null;
            }
            notify('Render dibatalkan', payload.data);
            break;
          case 'FatalError':
            appendLog(`FATAL: ${payload.data}`);
            setRunning(false);
            setOverallEta('Gagal');
            if (unlisten) {
              unlisten();
              unlisten = null;
            }
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
        minDurationHours: config.minDurationHours(),
        encoder,
        outputPrefix: config.outputPrefix(),
        maxrate: config.maxrate(),
        usePingpong: config.usePingpong(),
        youtubeTimestamps: config.youtubeTimestamps(),
      };

      await invoke('start_render', { config: DEFAULT_CONFIG, overrides });
    } catch (err) {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      appendLog(`Error: ${String(err)}`);
      setRunning(false);
      setOverallEta('Gagal');
    }
  };

  const cancelRender = async () => {
    try {
      await invoke('cancel_render');
    } catch {}
  };

  onCleanup(() => {
    if (unlisten) unlisten();
  });

  return {
    running,
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
    cancelRender,
    ...config,
  };
}
