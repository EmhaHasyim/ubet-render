import { useHardware, type HardwareInfo } from './useHardware';
import { useDragDrop } from './useDragDrop';
import type { MediaSource } from '../core/types';
import { CODECS } from '../core/config';
import { createLogger } from '../core/logger';
import { showToast } from '../core/toast';

const log = createLogger('usePipeline');

/**
 * Hardware detection with a software-encoder fallback, plus drag-and-drop
 * with graceful degradation. Each subsystem is wrapped independently so one
 * failure (e.g. missing Tauri IPC in browser dev) doesn't cascade into a
 * broken pipeline.
 */
export function useResilientPeripherals(
  config: {
    codec: () => string;
    setCodec: (v: string) => void;
    setVideoSource: (v: MediaSource) => void;
    setAudioSource: (v: MediaSource) => void;
    setOutputPath: (v: string) => void;
  },
  { appendLog }: { appendLog: (line: string) => void },
) {
  let hardwareInfo: () => HardwareInfo | null;
  let resolveEncoder: (codec: string) => string;
  try {
    const hw = useHardware(config.codec, config.setCodec);
    hardwareInfo = hw.hardwareInfo;
    resolveEncoder = hw.resolveEncoder;
  } catch (err) {
    log.error('useHardware failed, using fallback encoder:', err);
    appendLog(
      '[WARN] Hardware detection failed — using software encoder fallback',
    );
    showToast('Hardware detection failed — using software fallback', {
      variant: 'warning',
      ttl: 5000,
    });
    hardwareInfo = () => null;
    resolveEncoder = (codec) => {
      if (codec === CODECS.av1) return 'libsvtav1';
      if (codec === CODECS.h265) return 'libx265';
      return 'libx264';
    };
  }

  let dragHover: () => 'video' | 'audio' | 'output' | null;
  try {
    dragHover = useDragDrop(
      (src) => config.setVideoSource(src),
      (src) => config.setAudioSource(src),
      config.setOutputPath,
    ).dragHover;
  } catch (err) {
    log.error('useDragDrop failed, drag-drop disabled:', err);
    appendLog('[INFO] Drag-and-drop is unavailable in this environment');
    showToast('Drag-and-drop is unavailable in this environment', {
      variant: 'info',
      ttl: 4000,
    });
    dragHover = () => null;
  }

  return { hardwareInfo, resolveEncoder, dragHover };
}
