import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from '@iconify-icon/solid';
import {
  applyTheme,
  loadTheme,
  toggleTheme,
  type Theme,
} from '../../core/theme';

export function Titlebar() {
  const [isMaximized, setIsMaximized] = createSignal(false);
  const [showContextMenu, setShowContextMenu] = createSignal(false);
  const [theme, setTheme] = createSignal<Theme>('business');
  let contextMenuRef: HTMLDivElement | undefined;
  const appWindow = getCurrentWindow();

  onMount(async () => {
    // Load saved theme preference (or smart default from OS) and apply it
    // to <html data-theme="..."> immediately. Doing this on mount keeps the
    // initial paint theme-correct without waiting for the toggle click.
    const initial = loadTheme();
    setTheme(initial);
    applyTheme(initial);

    setIsMaximized(await appWindow.isMaximized());

    // ── Resize listener (debounced) ──────────────────────
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const unlistenResize = await appWindow.onResized(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        appWindow.isMaximized().then(setIsMaximized);
      }, 200);
    });

    // ── Click outside → close context menu ───────────────
    const closeMenuOnClick = (e: MouseEvent) => {
      if (contextMenuRef && !contextMenuRef.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    document.addEventListener('click', closeMenuOnClick);

    // ── Escape → close context menu ──────────────────────
    const closeMenuOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowContextMenu(false);
    };
    document.addEventListener('keydown', closeMenuOnEscape);

    // ── Cleanup all ──────────────────────────────────────
    onCleanup(() => {
      unlistenResize();
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      document.removeEventListener('click', closeMenuOnClick);
      document.removeEventListener('keydown', closeMenuOnEscape);
    });
  });

  const handleMinimize = () => appWindow.minimize();
  const handleToggleMaximize = () => appWindow.toggleMaximize();
  const handleClose = () => appWindow.hide();
  const handleToggleTheme = () => {
    const next = toggleTheme(theme());
    setTheme(next);
    applyTheme(next);
  };

  // Double-click titlebar → toggle maximize (Windows convention)
  const handleDoubleClick = () => appWindow.toggleMaximize();

  // Right-click titlebar → context menu
  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setShowContextMenu(true);
  };

  return (
    <div
      data-tauri-drag-region
      class="relative flex h-11 shrink-0 select-none items-center justify-between bg-base-100"
      onDblClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Left: drag region + app name */}
      <div class="flex items-center gap-2 pl-3">
        <div class="flex h-6 w-6 items-center justify-center rounded bg-base-200">
          <Icon
            icon="lucide:clapperboard"
            width="14"
            height="14"
            class="text-primary"
          />
        </div>
        <span class="text-xs font-medium text-base-content/60">
          Ubet Render
        </span>
      </div>

      {/* Right: window controls */}
      <div class="flex h-full" data-tauri-drag-region={false}>
        <button
          type="button"
          class="flex h-full w-12 items-center justify-center text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
          onClick={handleToggleTheme}
          aria-label={
            theme() === 'business'
              ? 'Switch to light theme'
              : 'Switch to dark theme'
          }
          title={
            theme() === 'business'
              ? 'Switch to light theme'
              : 'Switch to dark theme'
          }
        >
          <Icon
            icon={theme() === 'business' ? 'lucide:sun' : 'lucide:moon'}
            width="14"
            height="14"
          />
        </button>
        <button
          type="button"
          class="flex h-full w-12 items-center justify-center text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
          onClick={handleMinimize}
          aria-label="Minimize"
          tabIndex={-1}
        >
          <Icon icon="lucide:minus" width="16" height="16" />
        </button>
        <button
          type="button"
          class="flex h-full w-12 items-center justify-center text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
          onClick={handleToggleMaximize}
          aria-label={isMaximized() ? 'Restore' : 'Maximize'}
          tabIndex={-1}
        >
          <Icon
            icon={isMaximized() ? 'lucide:copy' : 'lucide:square'}
            width="14"
            height="14"
          />
        </button>
        <button
          type="button"
          class="flex h-full w-12 items-center justify-center text-base-content/50 transition-colors hover:bg-error hover:text-error-content"
          onClick={handleClose}
          aria-label="Close to tray"
          tabIndex={-1}
        >
          <Icon icon="lucide:x" width="16" height="16" />
        </button>
      </div>

      {/* ── Right-click context menu ──────────────────────────── */}
      <Show when={showContextMenu()}>
        <div
          ref={contextMenuRef}
          class="absolute left-2 top-full z-50 min-w-44 rounded-lg border border-base-300 bg-base-100 py-1 shadow-lg"
        >
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-base-content/80 hover:bg-base-200"
            onClick={() => {
              setShowContextMenu(false);
              handleToggleMaximize();
            }}
          >
            <Icon icon="lucide:copy" width="14" height="14" />
            {isMaximized() ? 'Restore' : 'Maximize'}
          </button>
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-base-content/80 hover:bg-base-200"
            onClick={() => {
              setShowContextMenu(false);
              handleMinimize();
            }}
          >
            <Icon icon="lucide:minus" width="14" height="14" />
            Minimize
          </button>
          <hr class="my-1 border-base-300" />
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-error hover:bg-base-200"
            onClick={() => {
              setShowContextMenu(false);
              handleClose();
            }}
          >
            <Icon icon="lucide:x" width="14" height="14" />
            Hide to tray
          </button>
        </div>
      </Show>
    </div>
  );
}
