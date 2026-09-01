import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import type { BackendConfigSnapshot } from '../core/buildAppConfig';
import { usePipelinePersistence } from './usePipelinePersistence';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

function makeConfig(codec: () => string = () => 'av1'): BackendConfigSnapshot {
  return {
    outputPath: () => '/output',
    outputPrefix: () => 'Test',
    minDurationHours: () => 1,
    maxrate: () => '4000k',
    codec,
    songsPerPlaylist: () => 9,
    audioMode: () => 'original',
    embedChapters: () => true,
  };
}

function mountPersistence(config: BackendConfigSnapshot = makeConfig()) {
  let persistence!: ReturnType<typeof usePipelinePersistence>;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    persistence = usePipelinePersistence(config, () => 'libsvtav1');
    return rootDispose;
  });
  return { persistence, dispose };
}

describe('usePipelinePersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('flushes the latest backend snapshot successfully', async () => {
    const { persistence, dispose } = mountPersistence();

    await expect(persistence.flush()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'save_config',
      expect.objectContaining({ config: expect.any(Object) }),
    );

    dispose();
  });

  it('retries transient save failures before reporting success', async () => {
    vi.useFakeTimers();
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    const { persistence, dispose } = mountPersistence();

    const flushPromise = persistence.flush();
    await vi.advanceTimersByTimeAsync(250);
    await expect(flushPromise).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(2);
    dispose();
    vi.useRealTimers();
  });

  it('persists a newer snapshot after a debounced save finishes in flight', async () => {
    vi.useFakeTimers();
    const [codec, setCodec] = createSignal('av1');
    let resolveFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(invoke)
      .mockReturnValueOnce(firstSave)
      .mockResolvedValue(undefined);

    const { dispose } = mountPersistence(makeConfig(codec));

    // Start the initial save and keep its IPC request pending.
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(1);

    // This edit schedules a second debounce while the first request is still
    // active. Its timer must not be lost when it observes saveInFlight.
    setCodec('h264');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(2);
    dispose();
    vi.useRealTimers();
  });
});
