// src/hooks/usePipeline.ts
import { createSignal, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { DEFAULT_CONFIG } from '../core/config';
import type { MediaSource, PipelineEvent, RenderJob } from '../core/types';

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
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

const STORAGE_KEY = 'ubetrender-paths';

function isMediaSource(value: unknown): value is MediaSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<MediaSource>;
  return source.type === 'files' && Array.isArray(source.paths) && source.paths.every((path) => typeof path === 'string');
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number, min: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function loadSavedPaths(): {
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  songsPerPlaylist: number;
  minDurationHours: number;
  codec: string;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        videoSource: isMediaSource(parsed.videoSource) ? parsed.videoSource : null,
        audioSource: isMediaSource(parsed.audioSource) ? parsed.audioSource : null,
        outputPath: stringOr(parsed.outputPath, ''),
        outputPrefix: stringOr(parsed.outputPrefix, DEFAULT_CONFIG.metadata.channelPrefix),
        maxrate: stringOr(parsed.maxrate, '4000k'),
        usePingpong: booleanOr(parsed.usePingpong, true),
        songsPerPlaylist: numberOr(parsed.songsPerPlaylist, DEFAULT_CONFIG.audio.songsPerPlaylist, 1),
        minDurationHours: numberOr(parsed.minDurationHours, DEFAULT_CONFIG.target.minDurationSec / 3600, 0.1),
        codec: ['h264', 'h265', 'av1'].includes(String(parsed.codec)) ? String(parsed.codec) : 'av1',
      };
    }
  } catch {}
  return {
    videoSource: null,
    audioSource: null,
    outputPath: '',
    outputPrefix: DEFAULT_CONFIG.metadata.channelPrefix,
    maxrate: '4000k',
    usePingpong: true,
    songsPerPlaylist: DEFAULT_CONFIG.audio.songsPerPlaylist,
    minDurationHours: DEFAULT_CONFIG.target.minDurationSec / 3600,
    codec: 'av1',
  };
}

function savePaths(data: {
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  songsPerPlaylist: number;
  minDurationHours: number;
  codec: string;
}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

export function usePipeline() {
  const [running, setRunning] = createSignal(false);
  const [jobs, setJobs] = createSignal<RenderJob[]>([]);
  const [overallProgress, setOverallProgress] = createSignal(0);
  const [overallEta, setOverallEta] = createSignal<string>('');
  const [dragHover, setDragHover] = createSignal<'video' | 'audio' | 'output' | null>(null);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [hardwareInfo, setHardwareInfo] = createSignal<{
    cpuModel: string;
    gpuModel: string;
    totalRamGB: number;
    av1Supported: boolean;
  } | null>(null);

  const saved = loadSavedPaths();

  const [videoSource, setVideoSource] = createSignal<MediaSource | null>(saved.videoSource);
  const [audioSource, setAudioSource] = createSignal<MediaSource | null>(saved.audioSource);
  const [outputPath, setOutputPath] = createSignal<string>(saved.outputPath);
  const [outputPrefix, setOutputPrefix] = createSignal<string>(saved.outputPrefix);
  const [maxrate, setMaxrate] = createSignal<string>(saved.maxrate);
  const [usePingpong, setUsePingpong] = createSignal<boolean>(saved.usePingpong);

  const [songsPerPlaylist, setSongsPerPlaylist] = createSignal(saved.songsPerPlaylist);
  const [minDurationHours, setMinDurationHours] = createSignal(saved.minDurationHours);
  const [codec, setCodec] = createSignal(saved.codec);

  let unlisten: UnlistenFn | null = null;

  const persist = () => savePaths({
    videoSource: videoSource(),
    audioSource: audioSource(),
    outputPath: outputPath(),
    outputPrefix: outputPrefix(),
    maxrate: maxrate(),
    usePingpong: usePingpong(),
    songsPerPlaylist: songsPerPlaylist(),
    minDurationHours: minDurationHours(),
    codec: codec(),
  });

  const appendLog = (line: string) => {
    setLogs((prev) => {
      const updated = [...prev, line];
      return updated.length > 500 ? updated.slice(-500) : updated;
    });
  };

  const pathsReady = () => {
    const v = videoSource();
    const a = audioSource();
    const o = outputPath();
    const videoOk = v !== null && v.paths.length > 0;
    const audioOk = a !== null && a.paths.length > 0;
    const outputOk = o.length > 0;
    return videoOk && audioOk && outputOk;
  };

  const canStart = () => {
    const info = hardwareInfo();
    if (!pathsReady() || info === null) return false;
    return codec() !== 'av1' || info.av1Supported;
  };

  const updateVideoSource = (src: MediaSource | null) => { setVideoSource(src); persist(); };
  const updateAudioSource = (src: MediaSource | null) => { setAudioSource(src); persist(); };
  const updateOutputPath = (path: string) => { setOutputPath(path); persist(); };
  const updateOutputPrefix = (prefix: string) => { setOutputPrefix(prefix); persist(); };
  const updateMaxrate = (val: string) => { setMaxrate(val); persist(); };
  const updateUsePingpong = (val: boolean) => { setUsePingpong(val); persist(); };

  onMount(() => {
    invoke<{
      cpu_name: string;
      gpu_name: string;
      ram_gb: number;
      av1_supported: boolean;
    }>('detect_hardware')
      .then((info) => {
        setHardwareInfo({
          cpuModel: info.cpu_name,
          gpuModel: info.gpu_name,
          totalRamGB: info.ram_gb,
          av1Supported: info.av1_supported,
        });

        if (!info.av1_supported && codec() === 'av1') {
          setCodec('h265');
        }
      })
      .catch((err) => {
        console.error('Hardware detection failed:', err);
        if (codec() === 'av1') {
          setCodec('h265');
        }
        setHardwareInfo({
          cpuModel: 'Tidak diketahui',
          gpuModel: 'Tidak diketahui',
          totalRamGB: 0,
          av1Supported: false,
        });
      });

    let unlistenDrag: UnlistenFn | null = null;
    
    const setupDrag = async () => {
      try {
        const appWindow = getCurrentWindow();
        unlistenDrag = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === 'over' || event.payload.type === 'enter') {
            const x = event.payload.position.x;
            const y = event.payload.position.y;
            const el = document.elementFromPoint(x, y);
            if (el?.closest('#video-dropzone')) setDragHover('video');
            else if (el?.closest('#audio-dropzone')) setDragHover('audio');
            else if (el?.closest('#output-dropzone')) setDragHover('output');
            else setDragHover(null);
          } else if (event.payload.type === 'leave') {
            setDragHover(null);
          } else if (event.payload.type === 'drop') {
            setDragHover(null);
            const paths = event.payload.paths;
            if (paths.length === 0) return;

            const x = event.payload.position.x;
            const y = event.payload.position.y;
            const el = document.elementFromPoint(x, y);

            if (el?.closest('#video-dropzone')) {
              updateVideoSource({ type: 'files', paths });
            } else if (el?.closest('#audio-dropzone')) {
              updateAudioSource({ type: 'files', paths });
            } else if (el?.closest('#output-dropzone')) {
              updateOutputPath(paths[0]);
            }
          }
        });
      } catch (e) {
        console.warn("Drag and drop event listener not supported or failed to bind", e);
      }
    };
    
    setupDrag();

    onCleanup(() => {
      if (unlistenDrag) unlistenDrag();
    });
  });

  const resolveEncoder = (codec: string): string => {
    const gpu = hardwareInfo()?.gpuModel.toLowerCase() || '';
    
    switch (codec) {
      case 'h264': 
        if (gpu.includes('nvidia')) return 'h264_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'h264_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'h264_qsv';
        return 'libx264';
      case 'h265': 
        if (gpu.includes('nvidia')) return 'hevc_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'hevc_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'hevc_qsv';
        return 'libx265';
      case 'av1': 
        if (!hardwareInfo()?.av1Supported) return resolveEncoder('h265');
        if (gpu.includes('nvidia')) return 'av1_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'av1_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'av1_qsv';
        return 'av1_nvenc';
      default: return 'libx264';
    }
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
          appendLog(`[${payload.data.level.toUpperCase()}] ${payload.data.message}`);
          break;
        case 'Progress':
          setJobs(payload.data.jobs);
          const totalJobs = payload.data.total;
          const jobsProgressSum = payload.data.jobs.reduce((sum, j) => sum + j.progressPercent, 0);
          const overallPct = totalJobs > 0 ? Math.min(100, Math.max(0, jobsProgressSum / totalJobs)) : 0;
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
          setOverallEta(payload.data.failed > 0 ? 'Selesai dengan error' : 'Selesai');
          if (unlisten) { unlisten(); unlisten = null; }
          notify(
            payload.data.failed > 0 ? 'Render selesai dengan error' : 'Render selesai',
            `${payload.data.completed}/${payload.data.total} selesai, ${payload.data.failed} gagal.`,
          );
          break;
        case 'Cancelled':
          appendLog(`[INFO] ${payload.data}`);
          setRunning(false);
          setOverallEta('Dibatalkan');
          if (unlisten) { unlisten(); unlisten = null; }
          notify('Render dibatalkan', payload.data);
          break;
        case 'FatalError':
          appendLog(`FATAL: ${payload.data}`);
          setRunning(false);
          setOverallEta('Gagal');
          if (unlisten) { unlisten(); unlisten = null; }
          notify('Render gagal', `Error: ${payload.data}`);
          break;
      }
    });

    const encoder = resolveEncoder(codec());

    const overrides = {
      videoSource: videoSource(),
      audioSource: audioSource(),
      outputPath: outputPath(),
      songsPerPlaylist: songsPerPlaylist(),
      minDurationHours: minDurationHours(),
      encoder,
      outputPrefix: outputPrefix(),
      maxrate: maxrate(),
      usePingpong: usePingpong(),
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
    } catch (err) {
      console.error('Failed to cancel render:', err);
    }
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
    videoSource,
    audioSource,
    outputPath,
    songsPerPlaylist,
    minDurationHours,
    codec,
    hardwareInfo,
    av1Supported: () => hardwareInfo()?.av1Supported ?? false,
    pathsReady,
    canStart,
    outputPrefix,
    maxrate,
    usePingpong,
    dragHover,
    setVideoSource: updateVideoSource,
    setAudioSource: updateAudioSource,
    setOutputPath: updateOutputPath,
    setOutputPrefix: updateOutputPrefix,
    setMaxrate: updateMaxrate,
    setUsePingpong: updateUsePingpong,
    setSongsPerPlaylist: (val: number) => { setSongsPerPlaylist(val); persist(); },
    setMinDurationHours: (val: number) => { setMinDurationHours(val); persist(); },
    setCodec: (val: string) => { setCodec(val); persist(); },
    startRender,
    cancelRender,
  };
}
