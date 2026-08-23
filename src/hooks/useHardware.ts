import { createSignal, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import type { HardwareInfo } from '../core/types';
import { CODECS } from '../core/config';

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
    }>('detect_hardware')
      .then((info) => {
        setHardwareInfo({
          cpuModel: info.cpuName,
          gpuModel: info.gpuName,
          totalRamGB: info.ramGb,
          av1Supported: info.av1Supported,
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
        });
      });
  });

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
      case CODECS.av1:
        if (!hardwareInfo()?.av1Supported) return resolveEncoder(CODECS.h265);
        if (gpu.includes('nvidia')) return 'av1_nvenc';
        if (gpu.includes('amd') || gpu.includes('radeon')) return 'av1_amf';
        if (gpu.includes('intel') || gpu.includes('arc')) return 'av1_qsv';
        return 'libsvtav1';
      default:
        return 'libx264';
    }
  };

  return { hardwareInfo, resolveEncoder };
}
