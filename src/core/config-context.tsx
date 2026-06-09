import { createContext, useContext, JSX } from 'solid-js';
import type { MediaSource } from './types';

export interface ConfigContextValue {
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  youtubeTimestamps: boolean;
  songsPerPlaylist: number;
  minDurationHours: number;
  codec: string;
  maxConcurrentJobs: number;
  watermarkPath: string | undefined;
  watermarkOpacity: number;
  setVideoSource: (v: MediaSource | null) => void;
  setAudioSource: (v: MediaSource | null) => void;
  setOutputPath: (v: string) => void;
  setOutputPrefix: (v: string) => void;
  setMaxrate: (v: string) => void;
  setUsePingpong: (v: boolean) => void;
  setYoutubeTimestamps: (v: boolean) => void;
  setSongsPerPlaylist: (v: number) => void;
  setMinDurationHours: (v: number) => void;
  setCodec: (v: string) => void;
  setMaxConcurrentJobs: (v: number) => void;
  setWatermarkPath: (v: string | undefined) => void;
  setWatermarkOpacity: (v: number) => void;
  av1Supported: () => boolean;
  pathsReady: () => boolean;
  canStart: () => boolean;
  dragHover: 'video' | 'audio' | 'output' | null;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider(props: { children: JSX.Element; value: ConfigContextValue }) {
  return <ConfigContext.Provider value={props.value}>{props.children}</ConfigContext.Provider>;
}

export function useConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return ctx;
}