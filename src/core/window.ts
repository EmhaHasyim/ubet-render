/**
 * Safe access to the Tauri window handle.
 *
 * `getCurrentWindow()` from `@tauri-apps/api/window` throws when the app is
 * loaded in a plain browser (e.g. `bun dev` without the Tauri webview)
 * because it reads `window.__TAURI_INTERNALS__`. Every call site that needs
 * the window object at component scope would otherwise crash the whole UI
 * in browser dev mode before the ErrorBoundary can catch it.
 *
 * This helper returns a no-op stub in that environment so the UI renders
 * normally and the (unavailable) window operations degrade to silent no-ops,
 * matching the behaviour documented in the README for browser dev mode.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

/** A window-shaped stub whose methods are all safe no-ops. */
const stubWindow = {
  onDragDropEvent: () => Promise.resolve(() => {}),
  isMaximized: async () => false,
  isFullscreen: async () => false,
  setFullscreen: async () => {},
  hide: async () => {},
  minimize: async () => {},
  toggleMaximize: async () => {},
  onResized: () => Promise.resolve(() => {}),
  setProgressBar: async () => {},
  close: async () => {},
  onCloseRequested: () => Promise.resolve(() => {}),
};

export type SafeWindow = ReturnType<typeof getCurrentWindow>;

export function getSafeWindow(): SafeWindow {
  try {
    return getCurrentWindow();
  } catch {
    return stubWindow as unknown as SafeWindow;
  }
}
