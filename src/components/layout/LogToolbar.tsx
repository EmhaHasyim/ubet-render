import { For, Show } from 'solid-js';
import { Icon } from '../ui/Icon';
import type { LogLevel } from '../../core/logLevels';
import { showToast } from '../../core/toast';

export interface LogFilterControls {
  enabledLevels: () => Set<LogLevel>;
  searchQuery: () => string;
  filteredCount: () => number;
  isFiltering: () => boolean;
  toggleLevel: (level: LogLevel) => void;
  handleSearchInput: (value: string) => void;
}

interface LevelChipMeta {
  level: LogLevel;
  label: string;
  activeClass: string;
  inactiveClass: string;
  icon: string;
}

const LEVEL_CHIPS = [
  {
    level: 'INFO',
    label: 'Info',
    activeClass: 'badge-info',
    inactiveClass: 'badge-outline text-base-content/60',
    icon: 'lucide:info',
  },
  {
    level: 'WARN',
    label: 'Warn',
    activeClass: 'badge-warning',
    inactiveClass: 'badge-outline text-base-content/60',
    icon: 'lucide:triangle-alert',
  },
  {
    level: 'ERROR',
    label: 'Error',
    activeClass: 'badge-error',
    inactiveClass: 'badge-outline text-base-content/60',
    icon: 'lucide:octagon-x',
  },
] as const satisfies readonly LevelChipMeta[];

export function LogToolbar(props: {
  logs: string[];
  controls: LogFilterControls;
}) {
  let searchInputRef: HTMLInputElement | undefined;
  const copyAll = async () => {
    const text = props.logs.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('Logs copied to clipboard', { variant: 'success' });
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showToast('Logs copied to clipboard', { variant: 'success' });
    }
  };

  return (
    <div class="flex flex-col gap-2 border-b border-base-300/70 px-3.5 py-2.5 shrink-0">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Icon
            icon="lucide:terminal"
            class="text-base-content/50"
            width="16"
            height="16"
          />
          <h3 class="text-sm font-semibold">Logs</h3>
        </div>
        <div class="flex items-center gap-1.5">
          <Show when={props.logs.length > 0}>
            <button
              type="button"
              class="btn btn-ghost btn-xs gap-1"
              title="Copy all logs to clipboard"
              aria-label="Copy all logs to clipboard"
              onClick={copyAll}
            >
              <Icon icon="lucide:clipboard-copy" width="12" height="12" />
              Copy all
            </button>
          </Show>
          <span
            class={`badge badge-ghost badge-sm font-mono ${props.controls.isFiltering() ? 'badge-info' : ''}`}
            aria-label={
              props.controls.isFiltering()
                ? `Showing ${props.controls.filteredCount()} of ${props.logs.length} log lines`
                : `${props.logs.length} log lines`
            }
          >
            {props.controls.isFiltering()
              ? `${props.controls.filteredCount()} / ${props.logs.length}`
              : props.logs.length}
          </span>
        </div>
      </div>
      <Show when={props.logs.length > 0}>
        <div class="flex flex-wrap items-center gap-3">
          <div class="join" role="group" aria-label="Filter by log level">
            <For each={LEVEL_CHIPS}>
              {(chip) => {
                const enabled = () =>
                  props.controls.enabledLevels().has(chip.level);
                return (
                  <button
                    type="button"
                    class={`badge join-item badge-sm gap-1 cursor-pointer transition-colors ${enabled() ? chip.activeClass : chip.inactiveClass}`}
                    aria-pressed={enabled()}
                    aria-label={`Toggle ${chip.label} log level`}
                    data-testid={`log-filter-${chip.level.toLowerCase()}`}
                    onClick={() => props.controls.toggleLevel(chip.level)}
                  >
                    <Icon icon={chip.icon} width="11" height="11" />
                    {chip.label}
                  </button>
                );
              }}
            </For>
          </div>
          <div class="relative flex-1 min-w-32">
            <Icon
              icon="lucide:search"
              class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-base-content/40"
              width="12"
              height="12"
            />
            <input
              ref={searchInputRef}
              type="text"
              class="input input-bordered input-xs w-full pl-7 pr-7 bg-base-100"
              placeholder="Filter logs…"
              value={props.controls.searchQuery()}
              aria-label="Filter log lines by text"
              data-testid="log-search-input"
              onInput={(event) =>
                props.controls.handleSearchInput(event.currentTarget.value)
              }
            />
            <Show when={props.controls.searchQuery().length > 0}>
              <button
                type="button"
                class="btn btn-ghost btn-xs btn-square absolute right-1 top-1/2 -translate-y-1/2"
                aria-label="Clear log filter"
                onClick={() => {
                  props.controls.handleSearchInput('');
                  searchInputRef?.focus();
                }}
              >
                <Icon icon="lucide:x" width="11" height="11" />
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
