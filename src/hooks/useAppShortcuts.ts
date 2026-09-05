import {
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from 'solid-js';
import { getSafeWindow } from '../core/window';
import { createLogger } from '../core/logger';

const log = createLogger('useAppShortcuts');

export type AppTabId = 'renderer' | 'activity';

export interface AppShortcuts {
  isShortcutsOpen: Accessor<boolean>;
  closeShortcuts: () => void;
}

/**
 * Window/tab/help shortcuts (F1, Ctrl+W, F11, Ctrl+1/2, Ctrl+Shift+M).
 *
 * Render controls (Ctrl+Enter/P/C) live in `Dashboard.tsx` because they need
 * live pipeline state. The two owners listen for disjoint key sets so they
 * never compete.
 *
 * Window-level shortcuts (F1, Ctrl+W, F11, Ctrl+Shift+M) are intentionally
 * global — they apply even while typing so a render can be backgrounded or
 * fullscreened from anywhere. Only the Ctrl+1/2 tab switches are suppressed
 * inside INPUT/TEXTAREA/SELECT so typing is never hijacked.
 */
export function useAppShortcuts(setActiveTab: Setter<AppTabId>): AppShortcuts {
  const [isShortcutsOpen, setShortcutsOpen] = createSignal(false);
  // Safe wrapper: in plain browser dev there is no Tauri window, and the
  // stub keeps the app renderable instead of throwing before the boundary.
  const appWindow = getSafeWindow();

  onMount(() => {
    // Track Tauri window fullscreen state (separate from browser
    // document.fullscreenElement — they are different APIs).
    //
    // Use a mutable closure variable instead of a signal because the
    // state is only consumed synchronously inside the F11 handler;
    // no component needs to reactively observe it.
    let isFullscreen = false;
    // Async probe the initial state; on failure assume non-fullscreen.
    appWindow
      .isFullscreen()
      .then((value) => {
        isFullscreen = value;
      })
      .catch((err) => {
        // IPC failed — safest default is false (windowed).
        log.warn('isFullscreen probe failed, assuming windowed:', err);
      });

    const handleKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      const isTyping =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const mod = event.metaKey || event.ctrlKey;
      // Only tab switches are suppressed while typing; the window-level
      // shortcuts (F1/W/F11/M) deliberately still apply (see module doc).
      if (isTyping && mod && (event.key === '1' || event.key === '2')) return;

      // F1 → toggle the shortcuts dialog.
      if (event.key === 'F1') {
        event.preventDefault();
        setShortcutsOpen((previous) => !previous);
        return;
      }

      // Ctrl/Cmd+W → hide window (close to tray, render keeps running).
      if (mod && event.key === 'w') {
        event.preventDefault();
        appWindow.hide().catch((err) => log.warn('hide window failed:', err));
        return;
      }

      // F11 → toggle Tauri window fullscreen.
      if (event.key === 'F11') {
        event.preventDefault();
        isFullscreen = !isFullscreen;
        appWindow
          .setFullscreen(isFullscreen)
          .catch((err) => log.warn('setFullscreen failed:', err));
        return;
      }

      // Ctrl/Cmd+Shift+M → minimize.
      if (mod && event.shiftKey && event.key === 'M') {
        event.preventDefault();
        appWindow.minimize().catch((err) => log.warn('minimize failed:', err));
        return;
      }

      // Ctrl+1 / Ctrl+2 → switch application tab.
      if (mod && event.key === '1') {
        event.preventDefault();
        setActiveTab('renderer');
        return;
      }
      if (mod && event.key === '2') {
        event.preventDefault();
        setActiveTab('activity');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });

  return {
    isShortcutsOpen,
    closeShortcuts: () => setShortcutsOpen(false),
  };
}
