import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';

// Must be at top level
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  })),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(false)),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
  sendNotification: vi.fn(),
}));

import { createRoot } from 'solid-js';
import { usePipeline } from './usePipeline';

function mountHook<T>(fn: () => T): T {
  let result!: T;
  createRoot((dispose) => {
    result = fn();
    return dispose;
  });
  return result;
}

/** Mount inside a rendered component so onMount fires. */
function mountRenderedHook<T>(useFn: () => T): { ref: T } {
  let result!: T;
  render(() => {
    result = useFn();
    return <div />;
  });
  return { ref: result };
}

describe('usePipeline', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns default signal values', () => {
    const p = mountHook(() => usePipeline());
    expect(p.running()).toBe(false);
    expect(p.paused()).toBe(false);
    expect(p.jobs()).toEqual([]);
    expect(p.overallProgress()).toBe(0);
    expect(p.overallEta()).toBe('');
    expect(p.logs()).toEqual([]);
    expect(p.liveStats()).toBeNull();
    expect(p.av1Supported()).toBe(false);
    expect(p.dragHover()).toBeNull();
  });

  it('maxrateValid returns true for default bitrate', () => {
    const p = mountHook(() => usePipeline());
    expect(p.maxrateValid()).toBe(true);
  });

  it('canStart returns false when paths are not set', () => {
    const p = mountHook(() => usePipeline());
    expect(p.canStart()).toBe(false);
  });

  it('returns default config values', () => {
    const p = mountHook(() => usePipeline());
    expect(p.codec()).toBe('av1');
    expect(p.maxrate()).toBe('4000k');
    expect(p.audioMode()).toBe('original');
    expect(p.outputFormat()).toBe('mp4');
    expect(p.songsPerPlaylist()).toBe(9);
    expect(p.outputPath()).toBe('');
    expect(p.videoSource()).toBeNull();
    expect(p.audioSource()).toBeNull();
  });

  it('allows setting config values', () => {
    const p = mountHook(() => usePipeline());
    p.setCodec('h265');
    p.setMaxrate('8000k');
    p.setAudioMode('normalize');
    expect(p.codec()).toBe('h265');
    expect(p.maxrate()).toBe('8000k');
    expect(p.audioMode()).toBe('normalize');
  });

  it('startRender is a no-op when not running and canStart is false', async () => {
    const p = mountHook(() => usePipeline());
    await p.startRender();
    expect(p.running()).toBe(false);
  });

  it('sets running to true when startRender succeeds', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

    // Mock detect_hardware so hardwareInfo resolves → canStart() passes
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'detect_hardware') {
        return {
          cpuName: 'CPU',
          gpuName: 'GPU',
          ramGb: 16,
          av1Supported: true,
        };
      }
      return undefined;
    });

    // Use rendered mount so onMount fires (detect_hardware runs)
    const { ref: p } = mountRenderedHook(() => usePipeline());

    // Set paths so pathsReady() → true
    p.setVideoSource({ type: 'files', paths: ['/v/test.mp4'] });
    p.setAudioSource({ type: 'files', paths: ['/a/test.mp3'] });
    p.setOutputPath('/out');

    // Wait for detect_hardware to resolve, then start
    await vi.waitFor(() => {
      expect(p.hardwareInfo()).not.toBeNull();
    });

    await p.startRender();
    expect(p.running()).toBe(true);
  });

  // v0.2.3 fix: if the backend's `Paused` event never arrives after
  // `pause_render` succeeded (IPC dropped, webview suspended), the reconcile
  // timer must revert `paused=true` back to `paused=false` so the user is not
  // stranded in a half-paused state.
  it('auto-reconciles paused state when backend never acks', async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'detect_hardware') {
          return {
            cpuName: 'CPU',
            gpuName: 'GPU',
            ramGb: 16,
            av1Supported: true,
          };
        }
        // `pause_render` returns successfully but NO pipeline-event with
        // `type: Paused` ever arrives → simulates an IPC drop.
        return undefined;
      });

      const { ref: p } = mountRenderedHook(() => usePipeline());
      p.setVideoSource({ type: 'files', paths: ['/v.mp4'] });
      p.setAudioSource({ type: 'files', paths: ['/a.mp3'] });
      p.setOutputPath('/o');

      await vi.waitFor(() => expect(p.hardwareInfo()).not.toBeNull());

      await p.startRender();
      expect(p.running()).toBe(true);

      // Fire-and-forget pause. The async function awaits invoke so we need
      // to flush microtasks/timers before checking the state.
      void p.pauseRender();
      await vi.advanceTimersByTimeAsync(10);
      expect(p.paused()).toBe(true);

      // 5 seconds pass without the Paused event arriving.
      await vi.advanceTimersByTimeAsync(5000);

      expect(p.paused()).toBe(false);
      expect(p.overallEta()).toBe('Pause timeout');
      // `running()` should still be true — the UI reverts to "rendering".
      expect(p.running()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
