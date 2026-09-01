import { Show, type Accessor, type Setter } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import type { AppTabId } from '../../hooks/useAppShortcuts';

/**
 * Left navigation rail — Arc / Discord-style.
 *
 * The previous design centred the two tabs inside the titlebar. Moving
 * navigation into a dedicated sidebar gives the app a desktop-native
 * composition: brand and window controls stay in the slim top bar, while
 * the rail anchors Render and Activity with an amber active pill and a
 * keyboard-friendly roving tabindex.
 */
export function Sidebar(props: {
  activeTab: Accessor<AppTabId>;
  setActiveTab: Setter<AppTabId>;
  jobCount: number;
}) {
  // Arrow-key navigation between the two tabs (roving tabindex).
  const handleTabsKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      props.setActiveTab((prev) =>
        prev === 'renderer' ? 'activity' : 'renderer',
      );
      requestAnimationFrame(() => {
        const el = document.querySelector(
          'button[role="tab"][aria-selected="true"]',
        ) as HTMLElement | null;
        el?.focus();
      });
    }
  };

  const navItemClass = (active: boolean) =>
    `relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors duration-150 ${
      active
        ? 'bg-primary/12 text-primary'
        : 'text-base-content/55 hover:bg-base-content/5 hover:text-base-content'
    }`;

  return (
    <nav
      aria-label="Main navigation"
      class="flex w-48 shrink-0 select-none flex-col border-r border-base-300/60 bg-base-100"
    >
      <div class="flex flex-col gap-0.5 p-2.5" onKeyDown={handleTabsKeyDown}>
        <p class="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-base-content/45">
          Workspace
        </p>

        <button
          type="button"
          role="tab"
          aria-selected={props.activeTab() === 'renderer'}
          tabIndex={props.activeTab() === 'renderer' ? 0 : -1}
          class={navItemClass(props.activeTab() === 'renderer')}
          onClick={() => props.setActiveTab('renderer')}
        >
          <Show when={props.activeTab() === 'renderer'}>
            <span class="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-primary" />
          </Show>
          <Icon
            icon="lucide:wand-sparkles"
            class="shrink-0"
            width="16"
            height="16"
          />
          Render
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={props.activeTab() === 'activity'}
          tabIndex={props.activeTab() === 'activity' ? 0 : -1}
          class={navItemClass(props.activeTab() === 'activity')}
          onClick={() => props.setActiveTab('activity')}
        >
          <Show when={props.activeTab() === 'activity'}>
            <span class="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-primary" />
          </Show>
          <Icon
            icon="lucide:list-checks"
            class="shrink-0"
            width="16"
            height="16"
          />
          Activity
          <Show when={props.jobCount > 0}>
            <span class="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
              {props.jobCount}
            </span>
          </Show>
        </button>
      </div>

      {/* ── Footer: keyboard shortcuts ──────────────────────── */}
      <div class="mt-auto border-t border-base-300/60 p-3">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-base-content/45">
          Shortcuts
        </p>
        <dl class="space-y-1 font-mono text-[10px] leading-relaxed text-base-content/55">
          <div class="flex items-center justify-between gap-2">
            <dt>Start batch</dt>
            <dd class="text-base-content/60">Ctrl+↵</dd>
          </div>
          <div class="flex items-center justify-between gap-2">
            <dt>Pause / resume</dt>
            <dd class="text-base-content/60">Ctrl+P</dd>
          </div>
          <div class="flex items-center justify-between gap-2">
            <dt>Switch tab</dt>
            <dd class="text-base-content/60">Ctrl+1/2</dd>
          </div>
          <div class="flex items-center justify-between gap-2">
            <dt>Keyboard help</dt>
            <dd class="text-base-content/60">F1</dd>
          </div>
        </dl>
      </div>
    </nav>
  );
}
