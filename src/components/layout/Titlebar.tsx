import {
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type Setter,
} from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import {
  applyTheme,
  loadTheme,
  toggleTheme,
  type Theme,
} from '../../core/theme';
import { getSafeWindow } from '../../core/window';
import type { AppTabId } from '../../hooks/useAppShortcuts';

const PAGE_LABELS: Record<AppTabId, string> = {
  renderer: 'Render setup',
  activity: 'Activity',
};

/**
 * Single chrome bar for the whole app.
 *
 * Navigation now lives in {@link Sidebar}, so this bar is a slim, purely
 * functional strip: brand + current page on the draggable left side, and
 * status pill + theme toggle + window controls on the right. The window
 * title mirrors the active page — the convention desktop users expect.
 */
export function Titlebar(props: {
  activeTab: Accessor<AppTabId>;
  setActiveTab: Setter<AppTabId>;
  running: boolean;
  paused: boolean;
  jobCount: number;
}) {
  const [isMaximized, setIsMaximized] = createSignal(false);
  const [showContextMenu, setShowContextMenu] = createSignal(false);
  const [theme, setTheme] = createSignal<Theme>('business');
  let contextMenuRef: HTMLDivElement | undefined;
  const appWindow = getSafeWindow();

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

  // Window-control actions are fire-and-forget: swallow rejections so a
  // failed IPC (e.g. the window is already gone) never surfaces as an
  // unhandled promise rejection.
  const handleMinimize = async () => {
    try {
      await appWindow.minimize();
    } catch {
      /* window may already be closing */
    }
  };
  const handleToggleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
    } catch {
      /* noop */
    }
  };
  const handleClose = async () => {
    try {
      await appWindow.hide();
    } catch {
      /* noop */
    }
  };
  const handleToggleTheme = () => {
    const next = toggleTheme(theme());
    setTheme(next);
    applyTheme(next);
  };

  // Double-click titlebar → toggle maximize (Windows convention). Scoped to
  // the left drag region so double-clicking the window-control buttons
  // (which bubble dblclick events) can't accidentally toggle maximize.
  const handleDoubleClick = async () => {
    try {
      await appWindow.toggleMaximize();
    } catch {
      /* noop */
    }
  };

  // Right-click titlebar → context menu
  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setShowContextMenu(true);
  };

  const controlClass =
    'flex h-full w-10 items-center justify-center text-base-content/55 transition-colors hover:bg-base-200 hover:text-base-content';

  return (
    <div
      data-tauri-drag-region
      class="relative flex h-11 shrink-0 select-none items-center border-b border-base-300/60 bg-base-100"
      onDblClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Left: drag region + brand + current page */}
      <div
        data-tauri-drag-region
        class="flex h-full min-w-0 items-center gap-2.5 pl-4"
      >
        <div
          data-tauri-drag-region
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary"
        >
          <Icon icon="lucide:clapperboard" width="15" height="15" />
        </div>
        <span
          data-tauri-drag-region
          class="truncate text-[13px] font-semibold tracking-tight text-base-content"
        >
          Ubet Render
        </span>
        <span
          data-tauri-drag-region
          class="hidden items-center gap-1.5 border-l border-base-300 pl-2.5 text-[12px] text-base-content/55 sm:flex"
        >
          {PAGE_LABELS[props.activeTab()]}
          <Show when={props.jobCount > 0}>
            <span class="rounded-full bg-base-300/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-base-content/60">
              {props.jobCount} job{props.jobCount === 1 ? '' : 's'}
            </span>
          </Show>
        </span>
      </div>

      {/* Right: status + window controls — stop dblclick bubbling so
          double-clicking a control button can't accidentally toggle maximize. */}
      {/* NOTE: no data-tauri-drag-region here on purpose — Tauri starts a
          window drag whenever the *event target itself* carries the
          attribute, so an attribute with value "false" would still drag. */}
      <div
        class="ml-auto flex h-full items-center gap-1 pr-1"
        onDblClick={(e) => e.stopPropagation()}
      >
        {/* Status pill */}
        <div class="flex items-center px-1" aria-live="polite">
          <Show when={props.paused}>
            <span class="flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
              <Icon icon="lucide:pause" width="11" height="11" />
              Paused
            </span>
          </Show>
          <Show
            when={props.running}
            fallback={
              <Show when={!props.paused}>
                <span class="flex items-center gap-1.5 rounded-full border border-base-300 px-2.5 py-1 text-[11px] font-medium text-base-content/55">
                  <span class="h-1.5 w-1.5 rounded-full bg-base-content/25" />
                  Idle
                </span>
              </Show>
            }
          >
            <span class="flex items-center gap-1.5 rounded-full border border-info/25 bg-info/10 px-2.5 py-1 text-[11px] font-medium text-info">
              <span class="loading loading-spinner loading-xs" />
              Rendering
            </span>
          </Show>
        </div>

        <button
          type="button"
          class={controlClass}
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
          class={controlClass}
          onClick={handleMinimize}
          aria-label="Minimize"
          tabIndex={-1}
        >
          <Icon icon="lucide:minus" width="16" height="16" />
        </button>
        <button
          type="button"
          class={controlClass}
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
          class={`${controlClass} hover:bg-error hover:text-error-content`}
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
