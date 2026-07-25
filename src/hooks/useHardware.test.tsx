import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import { createRoot } from 'solid-js';

// Must be at top level — vitest hoists it before imports
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import type { Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useHardware } from './useHardware';

/** Mount a hook inside a SolidJS reactive root and return its value. */
function mountHook<T>(fn: () => T): T {
  let result!: T;
  createRoot((dispose) => {
    result = fn();
    return dispose;
  });
  return result;
}

/**
 * Mount a hook that uses onMount by rendering it inside a component.
 * Returns `{ ref }` where `ref` is the hook's return value.
 */
function mountMountedHook<T>(useFn: () => T): { ref: T } {
  let result!: T;
  render(() => {
    result = useFn();
    return <div />;
  });
  return { ref: result };
}

describe('useHardware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null hardwareInfo initially', () => {
    const codec = () => 'av1';
    const setCodec = vi.fn();
    const hw = mountHook(() => useHardware(codec, setCodec));
    expect(hw.hardwareInfo()).toBeNull();
  });

  it('invokes detect_hardware on mount', () => {
    const codec = () => 'av1';
    const setCodec = vi.fn();
    (invoke as unknown as Mock).mockResolvedValue({
      cpuName: 'AMD Ryzen 9',
      gpuName: 'NVIDIA RTX 4090',
      ramGb: 64,
      av1Supported: true,
    });

    const { ref } = mountMountedHook(() => useHardware(codec, setCodec));
    expect(invoke).toHaveBeenCalledWith('detect_hardware');

    return vi.waitFor(() => {
      expect(ref.hardwareInfo()).not.toBeNull();
      expect(ref.hardwareInfo()?.cpuModel).toBe('AMD Ryzen 9');
      expect(ref.hardwareInfo()?.gpuModel).toBe('NVIDIA RTX 4090');
      expect(ref.hardwareInfo()?.totalRamGB).toBe(64);
      expect(ref.hardwareInfo()?.av1Supported).toBe(true);
    });
  });

  it('falls back to Unknown hardware on invoke failure', () => {
    const codec = () => 'av1';
    const setCodec = vi.fn();
    (invoke as unknown as Mock).mockRejectedValue(new Error('IPC error'));

    const { ref } = mountMountedHook(() => useHardware(codec, setCodec));

    return vi.waitFor(() => {
      expect(ref.hardwareInfo()).not.toBeNull();
      expect(ref.hardwareInfo()?.cpuModel).toBe('Unknown');
      expect(ref.hardwareInfo()?.gpuModel).toBe('Unknown');
      expect(ref.hardwareInfo()?.totalRamGB).toBe(0);
      expect(ref.hardwareInfo()?.av1Supported).toBe(false);
    });
  });

  it('falls back from AV1 to h265 when AV1 is unsupported', () => {
    const codec = () => 'av1';
    const setCodec = vi.fn();
    (invoke as unknown as Mock).mockResolvedValue({
      cpuName: 'Intel i7',
      gpuName: 'Intel UHD',
      ramGb: 32,
      av1Supported: false,
    });

    mountMountedHook(() => useHardware(codec, setCodec));

    return vi.waitFor(() => {
      expect(setCodec).toHaveBeenCalledWith('h265');
    });
  });

  it('does NOT change codec when AV1 is unsupported but codec is not AV1', () => {
    const codec = () => 'h264';
    const setCodec = vi.fn();
    (invoke as unknown as Mock).mockResolvedValue({
      cpuName: 'Intel i7',
      gpuName: 'Intel UHD',
      ramGb: 32,
      av1Supported: false,
    });

    mountMountedHook(() => useHardware(codec, setCodec));

    return vi.waitFor(() => {
      expect(setCodec).not.toHaveBeenCalled();
    });
  });

  describe('resolveEncoder', () => {
    it('resolves NVIDIA encoder for NVIDIA GPU', () => {
      const codec = () => 'av1';
      const setCodec = vi.fn();
      (invoke as unknown as Mock).mockResolvedValue({
        cpuName: 'AMD Ryzen',
        gpuName: 'NVIDIA GeForce RTX 4090',
        ramGb: 64,
        av1Supported: true,
      });

      const { ref } = mountMountedHook(() => useHardware(codec, setCodec));

      return vi.waitFor(() => {
        expect(ref.resolveEncoder('h264')).toBe('h264_nvenc');
        expect(ref.resolveEncoder('h265')).toBe('hevc_nvenc');
        expect(ref.resolveEncoder('av1')).toBe('av1_nvenc');
      });
    });

    it('resolves software encoder for unknown GPU', () => {
      const codec = () => 'av1';
      const setCodec = vi.fn();
      (invoke as unknown as Mock).mockResolvedValue({
        cpuName: 'Unknown',
        gpuName: 'Unknown GPU',
        ramGb: 8,
        av1Supported: true,
      });

      const { ref } = mountMountedHook(() => useHardware(codec, setCodec));

      return vi.waitFor(() => {
        expect(ref.resolveEncoder('h264')).toBe('libx264');
        expect(ref.resolveEncoder('h265')).toBe('libx265');
        expect(ref.resolveEncoder('av1')).toBe('libsvtav1');
      });
    });

    it('resolves AMD encoder for AMD GPU', () => {
      const codec = () => 'av1';
      const setCodec = vi.fn();
      (invoke as unknown as Mock).mockResolvedValue({
        cpuName: 'AMD Ryzen',
        gpuName: 'AMD Radeon RX 7900 XTX',
        ramGb: 32,
        av1Supported: true,
      });

      const { ref } = mountMountedHook(() => useHardware(codec, setCodec));

      return vi.waitFor(() => {
        expect(ref.resolveEncoder('h264')).toBe('h264_amf');
        expect(ref.resolveEncoder('h265')).toBe('hevc_amf');
        expect(ref.resolveEncoder('av1')).toBe('av1_amf');
      });
    });
  });
});
