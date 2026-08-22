import {
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  const appWindow = getCurrentWindow();

  onMount(() => {
    // Track Tauri window fullscreen state (separate from browser
    // document.fullscreenElement — they are different APIs).
    let isFullscreen = false;
    let fullscreenStateResolved = false;
    appWindow
      .isFullscreen()
      .then((value) => {
        if (!fullscreenStateResolved) {
          isFullscreen = value;
        }
      })
      .catch(() => {
        fullscreenStateResolved = true;
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
        fullscreenStateResolved = true;
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
