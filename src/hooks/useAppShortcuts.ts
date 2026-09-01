import {
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from 'solid-js';
import { getSafeWindow } from '../core/window';

export type AppTabId = 'renderer' | 'activity';

export interface AppShortcuts {
  isShortcutsOpen: Accessor<boolean>;
  closeShortcuts: () => void;
}

/**
 * Register the application's global keyboard shortcuts in one place.
 *
 * Keeping window controls, tab navigation, and help-dialog toggling in a
 * single owner prevents multiple listeners from competing for the same key
 * events while preserving the existing shortcut behavior.
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
      .catch(() => {
        // IPC failed — safest default is false (windowed).
      });

    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;

      // F1 → toggle the shortcuts dialog.
      if (event.key === 'F1') {
        event.preventDefault();
        setShortcutsOpen((previous) => !previous);
        return;
      }

      // Ctrl/Cmd+W → hide window (close to tray, render keeps running).
      if (mod && event.key === 'w') {
        event.preventDefault();
        appWindow.hide().catch(() => {});
        return;
      }

      // F11 → toggle Tauri window fullscreen.
      if (event.key === 'F11') {
        event.preventDefault();
        isFullscreen = !isFullscreen;
        appWindow.setFullscreen(isFullscreen).catch(() => {});
        return;
      }

      // Ctrl/Cmd+Shift+M → minimize.
      if (mod && event.shiftKey && event.key === 'M') {
        event.preventDefault();
        appWindow.minimize().catch(() => {});
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
