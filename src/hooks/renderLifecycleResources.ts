import type { UnlistenFn } from '@tauri-apps/api/event';

export interface RenderLifecycleResources {
  setListener: (listener: UnlistenFn) => void;
  safeUnlisten: () => void;
  cancelPauseReconcile: () => void;
  schedulePauseReconcile: (callback: () => void, delayMs: number) => void;
  dispose: () => void;
}

export function createRenderLifecycleResources(): RenderLifecycleResources {
  let unlisten: UnlistenFn | null = null;
  let unlistenGuard = false;
  let pauseReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  const safeUnlisten = (): void => {
    if (!unlistenGuard && unlisten) {
      unlistenGuard = true;
      unlisten();
      unlisten = null;
    }
  };

  const setListener = (listener: UnlistenFn): void => {
    unlisten = listener;
    unlistenGuard = false;
  };

  const cancelPauseReconcile = (): void => {
    if (pauseReconcileTimer !== null) {
      clearTimeout(pauseReconcileTimer);
      pauseReconcileTimer = null;
    }
  };

  const schedulePauseReconcile = (
    callback: () => void,
    delayMs: number,
  ): void => {
    cancelPauseReconcile();
    pauseReconcileTimer = setTimeout(() => {
      pauseReconcileTimer = null;
      callback();
    }, delayMs);
  };

  return {
    setListener,
    safeUnlisten,
    cancelPauseReconcile,
    schedulePauseReconcile,
    dispose: () => {
      safeUnlisten();
      cancelPauseReconcile();
    },
  };
}
