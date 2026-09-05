import { createEffect, onCleanup } from 'solid-js';
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

export interface PipelinePersistence {
  /** Flushes the latest snapshot and resolves false when all attempts fail. */
  flush: () => Promise<boolean>;
}

/**
 * Persist the subset of frontend settings represented by the backend
 * AppConfig. Render-only overrides such as output format and loop mode are
 * intentionally excluded because they are sent with start_render instead.
 *
 * Saves are debounced during editing and exposed through `flush()` so a
 * render never starts while the backend is knowingly holding an older
 * configuration. A failed write surfaces a toast; retrying won't fix a
 * disk-full or permission error, so the user retries via the UI.
 */
export function usePipelinePersistence(
  config: BackendConfigSnapshot,
  resolveEncoder: (codec: string) => string,
): PipelinePersistence {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let latestConfig: AppConfig | null = null;
  let saveInFlight: Promise<boolean> | null = null;

  const schedulePersist = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  };

  const saveSnapshot = async (snapshot: AppConfig): Promise<boolean> => {
    try {
      await invoke(TAURI_COMMANDS.saveConfig, { config: snapshot });
      return true;
    } catch (err) {
      log.error('Failed to save backend config:', err);
      showToast('Settings could not be saved to disk', {
        variant: 'warning',
        ttl: 5000,
      });
      return false;
    }
  };

  const save = (): Promise<boolean> => {
    if (latestConfig === null) return Promise.resolve(true);
    if (saveInFlight !== null) return saveInFlight;

    const snapshot = latestConfig;
    const task = saveSnapshot(snapshot);

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
      if (!(await save())) return false;
      return latestConfig === snapshot ? true : flushLatest();
    };
    return flushLatest();
  };

  onCleanup(() => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    // A cleanup cannot await, but starting the final save prevents the common
    // remount/error-boundary path from dropping a pending backend snapshot.
    void save();
  });

  return { flush };
}
