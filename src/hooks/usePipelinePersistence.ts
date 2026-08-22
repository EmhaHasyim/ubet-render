import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import {
  buildAppConfig,
  type BackendConfigSnapshot,
} from '../core/buildAppConfig';
import type { AppConfig } from '../core/types';
import { TAURI_COMMANDS } from '../core/constants';
import { createLogger } from '../core/logger';
import { showToast } from '../core/toast';

const log = createLogger('usePipeline');
const SAVE_DEBOUNCE_MS = 500;
const RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 250;

export interface PipelinePersistence {
  /** True while the latest frontend settings are not confirmed on disk. */
  dirty: Accessor<boolean>;
  /** Flushes the latest snapshot and resolves false when all attempts fail. */
  flush: () => Promise<boolean>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Persist the subset of frontend settings represented by the backend
 * AppConfig. Render-only overrides such as output format and loop mode are
 * intentionally excluded because they are sent with start_render instead.
 *
 * Saves are debounced during editing, retried after transient IPC/filesystem
 * failures, and exposed through `flush()` so a render never starts while the
 * backend is knowingly holding an older configuration.
 */
export function usePipelinePersistence(
  config: BackendConfigSnapshot,
  resolveEncoder: (codec: string) => string,
): PipelinePersistence {
  const [dirty, setDirty] = createSignal(false);
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let latestConfig: AppConfig | null = null;
  let saveInFlight: Promise<boolean> | null = null;

  const schedulePersist = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void saveWithRetry();
    }, SAVE_DEBOUNCE_MS);
  };

  const saveSnapshotWithRetry = async (
    snapshot: AppConfig,
    attempt = 0,
  ): Promise<boolean> => {
    try {
      await invoke(TAURI_COMMANDS.saveConfig, { config: snapshot });
      // A newer edit may have arrived while this request was in flight.
      // Keep dirty=true in that case so the newer snapshot is not lost.
      if (latestConfig === snapshot) setDirty(false);
      return true;
    } catch (err) {
      log.error(
        `Failed to save backend config (attempt ${attempt + 1}/${RETRY_COUNT}):`,
        err,
      );
      if (attempt + 1 < RETRY_COUNT) {
        await wait(RETRY_BASE_DELAY_MS * 2 ** attempt);
        return saveSnapshotWithRetry(snapshot, attempt + 1);
      }
    }

    setDirty(true);
    showToast('Settings could not be saved to disk', {
      variant: 'warning',
      ttl: 5000,
    });
    return false;
  };

  const saveWithRetry = (): Promise<boolean> => {
    if (latestConfig === null) return Promise.resolve(true);
    if (saveInFlight !== null) return saveInFlight;

    const snapshot = latestConfig;
    const task = saveSnapshotWithRetry(snapshot);

    saveInFlight = task.finally(() => {
      saveInFlight = null;
      // If the debounce timer fired while this request was in flight, it
      // could only observe the old request. Schedule another save now so the
      // newest snapshot is eventually persisted without requiring another
      // user edit or an explicit flush.
      if (latestConfig !== snapshot && persistTimer === null) {
        schedulePersist();
      }
    });
    return saveInFlight;
  };

  createEffect(() => {
    void [
      config.codec(),
      config.maxrate(),
      config.songsPerPlaylist(),
      config.minDurationHours(),
      config.outputPrefix(),
      config.outputPath(),
      config.embedChapters(),
      config.audioMode(),
    ];

    latestConfig = buildAppConfig(config, resolveEncoder);
    setDirty(true);
    schedulePersist();
  });

  const flush = async (): Promise<boolean> => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

    // If an edit arrives while a save is in flight, wait for that save and
    // then persist the newer snapshot too. A single successful request must
    // never make `startRender` believe the latest settings are durable.
    const flushLatest = async (): Promise<boolean> => {
      const snapshot = latestConfig;
      if (snapshot === null) return true;
      if (!(await saveWithRetry())) return false;
      return latestConfig === snapshot ? true : flushLatest();
    };
    return flushLatest();
  };

  onCleanup(() => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    // A cleanup cannot await, but starting the final save prevents the common
    // remount/error-boundary path from dropping a pending backend snapshot.
    void saveWithRetry();
  });

  return { dirty, flush };
}
