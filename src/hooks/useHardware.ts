import { createSignal, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import type { HardwareInfo } from '../core/types';
import { CODECS } from '../core/config';
import { TAURI_COMMANDS } from '../core/constants';

export type { HardwareInfo } from '../core/types';

export function useHardware(
  currentCodec: () => string,
  setCodec: (c: string) => void,
) {
  const [hardwareInfo, setHardwareInfo] = createSignal<HardwareInfo | null>(
    null,
  );

  onMount(() => {
    // Read the codec again when the async probe resolves. The user may
    // change it while the IPC call is in flight; a stale captured value must
    // never overwrite a newer selection.

    invoke<{
      cpuName: string;
      gpuName: string;
      ramGb: number;
      av1Supported: boolean;
      av1Encoder: string | null;
    }>(TAURI_COMMANDS.detectHardware)
      .then((info) => {
        setHardwareInfo({
          cpuModel: info.cpuName,
          gpuModel: info.gpuName,
          totalRamGB: info.ramGb,
          av1Supported: info.av1Supported,
          av1Encoder: info.av1Encoder ?? null,
        });

        if (!info.av1Supported && currentCodec() === CODECS.av1) {
          setCodec(CODECS.h265);
        }
      })
      .catch(() => {
        if (currentCodec() === CODECS.av1) {
          setCodec(CODECS.h265);
        }
        setHardwareInfo({
          cpuModel: 'Unknown',
          gpuModel: 'Unknown',
          totalRamGB: 0,
          av1Supported: false,
          av1Encoder: null,
        });
      });
  });

  // GPU-vendor substring → encoder is a heuristic, not a probe: the startup
  // detect_hardware probe only resolves AV1. H.264/H.265 keep the heuristic
  // because the backend re-verifies any hardware encoder before a batch and
  // falls back to software when it cannot encode, so a wrong vendor guess
  // costs a probe rather than a failed render. AV1 uses the probed encoder
  // name because a vendor match does not imply AV1 hardware (e.g. RTX 30).
  const resolveEncoder = (codec: string): string => {
    const gpu = hardwareInfo()?.gpuModel.toLowerCase() || '';
    switch (codec) {
      case CODECS.h264:
        if (gpu.includes('nvidia')) return 'h264_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'h264_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'h264_qsv';
        return 'libx264';
      case CODECS.h265:
        if (gpu.includes('nvidia')) return 'hevc_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'hevc_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'hevc_qsv';
        return 'libx265';
      case CODECS.av1: {
        const probed = hardwareInfo()?.av1Encoder;
        if (probed) return probed;
        return resolveEncoder(CODECS.h265);
      }
      default:
        return 'libx264';
    }
  };

  return { hardwareInfo, resolveEncoder };
}
