import { createSignal } from 'solid-js';
import { DEFAULT_CONFIG } from '../core/config';
import type { MediaSource } from '../core/types';

const STORAGE_KEY = 'ubetrender-paths';

function isMediaSource(value: unknown): value is MediaSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<MediaSource>;
  return (
    source.type === 'files' &&
    Array.isArray(source.paths) &&
    source.paths.every((path) => typeof path === 'string')
  );
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number, min: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? value
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

export function usePersistedConfig() {
  let initial = {
    videoSource: null as MediaSource | null,
    audioSource: null as MediaSource | null,
    outputPath: '',
    outputPrefix: DEFAULT_CONFIG.metadata.channelPrefix,
    maxrate: '4000k',
    usePingpong: true,
    youtubeTimestamps: true,
    songsPerPlaylist: DEFAULT_CONFIG.audio.songsPerPlaylist,
    minDurationHours: DEFAULT_CONFIG.target.minDurationSec / 3600,
    codec: 'av1',
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      initial = {
        videoSource: isMediaSource(parsed.videoSource)
          ? parsed.videoSource
          : null,
        audioSource: isMediaSource(parsed.audioSource)
          ? parsed.audioSource
          : null,
        outputPath: stringOr(parsed.outputPath, ''),
        outputPrefix: stringOr(
          parsed.outputPrefix,
          DEFAULT_CONFIG.metadata.channelPrefix,
        ),
        maxrate: stringOr(parsed.maxrate, '4000k'),
        usePingpong: booleanOr(parsed.usePingpong, true),
        youtubeTimestamps: booleanOr(parsed.youtubeTimestamps, true),
        songsPerPlaylist: numberOr(
          parsed.songsPerPlaylist,
          DEFAULT_CONFIG.audio.songsPerPlaylist,
          1,
        ),
        minDurationHours: numberOr(
          parsed.minDurationHours,
          DEFAULT_CONFIG.target.minDurationSec / 3600,
          0.1,
        ),
        codec: ['h264', 'h265', 'av1'].includes(String(parsed.codec))
          ? String(parsed.codec)
          : 'av1',
      };
    }
  } catch {}

  const [videoSource, setVideoSource] = createSignal<MediaSource | null>(
    initial.videoSource,
  );
  const [audioSource, setAudioSource] = createSignal<MediaSource | null>(
    initial.audioSource,
  );
  const [outputPath, setOutputPath] = createSignal<string>(initial.outputPath);
  const [outputPrefix, setOutputPrefix] = createSignal<string>(
    initial.outputPrefix,
  );
  const [maxrate, setMaxrate] = createSignal<string>(initial.maxrate);
  const [usePingpong, setUsePingpong] = createSignal<boolean>(
    initial.usePingpong,
  );
  const [youtubeTimestamps, setYoutubeTimestamps] = createSignal<boolean>(
    initial.youtubeTimestamps,
  );
  const [songsPerPlaylist, setSongsPerPlaylist] = createSignal(
    initial.songsPerPlaylist,
  );
  const [minDurationHours, setMinDurationHours] = createSignal(
    initial.minDurationHours,
  );
  const [codec, setCodec] = createSignal(initial.codec);

  const persist = () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          videoSource: videoSource(),
          audioSource: audioSource(),
          outputPath: outputPath(),
          outputPrefix: outputPrefix(),
          maxrate: maxrate(),
          usePingpong: usePingpong(),
          youtubeTimestamps: youtubeTimestamps(),
          songsPerPlaylist: songsPerPlaylist(),
          minDurationHours: minDurationHours(),
          codec: codec(),
        }),
      );
    } catch {}
  };

  return {
    videoSource,
    audioSource,
    outputPath,
    outputPrefix,
    maxrate,
    usePingpong,
    youtubeTimestamps,
    songsPerPlaylist,
    minDurationHours,
    codec,
    setVideoSource: (v: MediaSource | null) => {
      setVideoSource(v);
      persist();
    },
    setAudioSource: (v: MediaSource | null) => {
      setAudioSource(v);
      persist();
    },
    setOutputPath: (v: string) => {
      setOutputPath(v);
      persist();
    },
    setOutputPrefix: (v: string) => {
      setOutputPrefix(v);
      persist();
    },
    setMaxrate: (v: string) => {
      setMaxrate(v);
      persist();
    },
    setUsePingpong: (v: boolean) => {
      setUsePingpong(v);
      persist();
    },
    setYoutubeTimestamps: (v: boolean) => {
      setYoutubeTimestamps(v);
      persist();
    },
    setSongsPerPlaylist: (v: number) => {
      setSongsPerPlaylist(v);
      persist();
    },
    setMinDurationHours: (v: number) => {
      setMinDurationHours(v);
      persist();
    },
    setCodec: (v: string) => {
      setCodec(v);
      persist();
    },
  };
}
