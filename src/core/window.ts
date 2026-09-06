/**
 * Safe access to the Tauri window handle.
 *
 * `getCurrentWindow()` from `@tauri-apps/api/window` throws when the app is
 * loaded in a plain browser (e.g. `bun dev` without the Tauri webview)
 * because it reads `window.__TAURI_INTERNALS__`. Call sites that only need
 * fire-and-forget window ops use this helper to avoid crashing the whole UI
 * in browser dev mode. Call sites that must *detect* Tauri presence (e.g.
 * `useDragDrop`, which falls back to HTML5 DnD) keep their own try/catch
 * around the raw `getCurrentWindow()` instead — this stub succeeds silently
 * and would hide Tauri's absence from them.
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
    // SAFETY: stubWindow mirrors the subset of the Tauri Window API used
    // through this helper (all no-op async fns); callers never touch fields
    // outside that subset, so the cast cannot observe a missing member.
    return stubWindow as unknown as SafeWindow;
  }
}
