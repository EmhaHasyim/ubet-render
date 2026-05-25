import { createSignal, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

export interface HardwareInfo {
  cpuModel: string;
  gpuModel: string;
  totalRamGB: number;
  av1Supported: boolean;
}

export function useHardware(
  currentCodec: () => string,
  setCodec: (c: string) => void,
) {
  const [hardwareInfo, setHardwareInfo] = createSignal<HardwareInfo | null>(
    null,
  );

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

        if (!info.av1_supported && currentCodec() === 'av1') {
          setCodec('h265');
        }
      })
      .catch(() => {
        if (currentCodec() === 'av1') {
          setCodec('h265');
        }
        setHardwareInfo({
          cpuModel: 'Tidak diketahui',
          gpuModel: 'Tidak diketahui',
          totalRamGB: 0,
          av1Supported: false,
        });
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
      default:
        return 'libx264';
    }
  };

  return { hardwareInfo, resolveEncoder };
}
