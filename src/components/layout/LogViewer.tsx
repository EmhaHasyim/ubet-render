import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { LogLine } from '../ui/LogLine';
import {
  FILTERABLE_LEVELS,
  parseLevel,
  type LogLevel,
} from '../../core/logLevels';

// Estimated height (px) of a single log line in the monospace container.
// Used by the virtual scroller to calculate the visible window.
const ROW_HEIGHT = 20;
const OVERSCAN = 15;

const ALL_LEVELS: LogLevel[] = FILTERABLE_LEVELS;

interface LevelChipMeta {
  level: LogLevel;
  label: string;
  // DaisyUI `badge` color matching LogLine's text colour for visual continuity.
  activeClass: string;
  inactiveClass: string;
  icon: string;
}

const LEVEL_CHIPS: LevelChipMeta[] = [
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
];

export function LogViewer(props: { logs: string[] }) {
  let containerRef!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [shouldAutoScroll, setShouldAutoScroll] = createSignal(true);

  // ---- Filter / search state (local — never persisted) ----
  // Default: all 3 levels enabled, no search query. Mirrors "show
  // everything" so the existing tests that look up first-paint DOM
  // remain valid.
  const [enabledLevels, setEnabledLevels] = createSignal<Set<LogLevel>>(
    new Set(ALL_LEVELS),
  );
  const [searchQuery, setSearchQuery] = createSignal('');
  let searchInputRef: HTMLInputElement | undefined;

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((cur) => {
      const next = new Set(cur);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  // Filtered (and search-narrowed) view of the logs that the virtual
  // scroller renders. Level filter short-circuits: if every level is
  // on, only the search predicate runs. Otherwise we filter twice.
  //
  // Unrecognised lines (parseLevel returns null) belong to the INFO
  // bucket — historical behaviour from 0.2.3 where "INFO" was the
  // catch-all for non-tagged text. Toggling the Info chip off hides
  // those lines along with bracketed `[INFO]` ones.
  const filteredLogs = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const levels = enabledLevels();
    const allOn = levels.size === ALL_LEVELS.length;

    const matches = (line: string): boolean => {
      if (allOn) return true;
      const level = parseLevel(line) ?? 'INFO';
      return levels.has(level);
    };

    return props.logs.filter((line) => {
      if (!matches(line)) return false;
      if (query && !line.toLowerCase().includes(query)) return false;
      return true;
    });
  });

  const isFiltering = createMemo(
    () =>
      enabledLevels().size !== ALL_LEVELS.length ||
      searchQuery().trim().length > 0,
  );

  // Reset virtual scroll position ONLY on coarse-grained filter changes
  // (chip toggle). Tracking `filteredLogs()` directly would fire on every
  // raw log line — yanking the user back to the top mid-inspect every
  // time ffmpeg emits a newline. Tracking `searchQuery()` would fire on
  // every keystroke, which is just as jarring: typing "abort" would
  // yank the user to the top four times.
  //
  // The right granularity is: chip toggles reset scroll (a discrete
  // click where a reset is expected), and search-input keystrokes only
  // narrow the list — the user keeps the scroll position they were
  // inspecting, which is the natural flow of "I typed a query and want
  // to see what's left".
  createEffect(() => {
    enabledLevels();
    setScrollTop(0);
    if (containerRef) containerRef.scrollTop = 0;
  });

  // ---- Virtual scrolling math (operates on filteredLogs, not raw logs) ----
  const startIndex = () =>
    Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);

  const visibleCount = () =>
    viewportHeight() > 0
      ? Math.ceil(viewportHeight() / ROW_HEIGHT) + OVERSCAN * 2
      : filteredLogs().length; // fallback: render all until viewport measured

  const endIndex = () =>
    Math.min(filteredLogs().length, startIndex() + visibleCount());

  const visibleLogs = createMemo(() =>
    filteredLogs().slice(startIndex(), endIndex()),
  );
  const topPadding = () => startIndex() * ROW_HEIGHT;
  const bottomPadding = () => (filteredLogs().length - endIndex()) * ROW_HEIGHT;

  const handleScroll = () => {
    if (!containerRef) return;
    setScrollTop(containerRef.scrollTop);

    // Detect whether the user is scrolled near the bottom so we know
    // whether to auto-scroll when new logs arrive.
    const el = containerRef;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShouldAutoScroll(distanceFromBottom < ROW_HEIGHT * 3);
  };

  // Track rAF ids so we can cancel on cleanup to avoid accessing
  // a stale containerRef after unmount.
  let rAFId = 0;

  // Measure the viewport once on mount and on resize.
  onMount(() => {
    if (!containerRef) return;
    setViewportHeight(containerRef.clientHeight);

    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
      // If the user was at the bottom, re-scroll so new content stays visible.
      if (shouldAutoScroll()) {
        rAFId = requestAnimationFrame(() => {
          if (!containerRef) return;
          containerRef.scrollTop = containerRef.scrollHeight;
        });
      }
    });
    observer.observe(containerRef);
    onCleanup(() => {
      observer.disconnect();
      cancelAnimationFrame(rAFId);
    });
  });

  // Auto-scroll to bottom when new logs arrive and the user hasn't scrolled up.
  // Track the logs array reference (not just length) so auto-scroll continues
  // to work after the ring buffer fills up and length stops changing.
  createEffect(() => {
    filteredLogs();
    if (!containerRef || !shouldAutoScroll()) return;

    const id = requestAnimationFrame(() => {
      if (!containerRef) return;
      containerRef.scrollTop = containerRef.scrollHeight;
      setScrollTop(containerRef.scrollTop);
    });
    onCleanup(() => cancelAnimationFrame(id));
  });

  return (
    <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      {/* ---- Header: title, level chips, search, count badge ---- */}
      <div class="flex flex-col gap-2 border-b border-base-300 px-3 py-2 shrink-0">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:terminal"
              class="text-primary"
              width="18"
              height="18"
            />
            <h3 class="font-semibold">Logs</h3>
          </div>
          <span
            class={`badge badge-ghost badge-sm font-mono ${
              isFiltering() ? 'badge-info' : ''
            }`}
            aria-label={
              isFiltering()
                ? `Showing ${filteredLogs().length} of ${props.logs.length} log lines`
                : `${props.logs.length} log lines`
            }
          >
            {isFiltering()
              ? `${filteredLogs().length} / ${props.logs.length}`
              : props.logs.length}
          </span>
        </div>

        <Show when={props.logs.length > 0}>
          <div class="flex flex-wrap items-center gap-3">
            {/* Level filter chips: each becomes a button that toggles its
                level on/off. We deliberately avoid a `<select>` so the
                visual continuity with the line colour is intact. */}
            <div class="join" role="group" aria-label="Filter by log level">
              <For each={LEVEL_CHIPS}>
                {(chip) => {
                  const enabled = () => enabledLevels().has(chip.level);
                  return (
                    <button
                      type="button"
                      class={`badge join-item badge-sm gap-1 cursor-pointer transition-colors ${
                        enabled() ? chip.activeClass : chip.inactiveClass
                      }`}
                      aria-pressed={enabled()}
                      aria-label={`Toggle ${chip.label} log level`}
                      data-testid={`log-filter-${chip.level.toLowerCase()}`}
                      onClick={() => toggleLevel(chip.level)}
                    >
                      <Icon icon={chip.icon} width="11" height="11" />
                      {chip.label}
                    </button>
                  );
                }}
              </For>
            </div>

            {/* Search box: substring match against the raw line text. */}
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
                value={searchQuery()}
                aria-label="Filter log lines by text"
                data-testid="log-search-input"
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
              <Show when={searchQuery().length > 0}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-square absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label="Clear log filter"
                  onClick={() => {
                    setSearchQuery('');
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

      <div
        ref={containerRef}
        class="min-h-0 flex-1 overflow-y-auto bg-neutral p-3 font-mono text-xs leading-relaxed text-neutral-content custom-scrollbar"
        onScroll={handleScroll}
      >
        <Show
          when={filteredLogs().length > 0}
          fallback={
            <Show
              when={props.logs.length > 0}
              fallback={
                <div class="py-10 text-center text-neutral-content/65">
                  No log output yet.
                </div>
              }
            >
              <div class="py-10 text-center text-neutral-content/65">
                <Icon
                  icon="lucide:filter-x"
                  class="mx-auto mb-2 opacity-70"
                  width="22"
                  height="22"
                />
                No log lines match the current filter.
              </div>
            </Show>
          }
        >
          {/* Virtual scroller: only renders visible lines + overscan.
            Correct scroll height is maintained via padding-top/padding-bottom. */}
          <div
            style={{
              'padding-top': `${topPadding()}px`,
              'padding-bottom': `${bottomPadding()}px`,
            }}
          >
            <For each={visibleLogs()}>{(line) => <LogLine text={line} />}</For>
          </div>
        </Show>
      </div>
    </section>
  );
}
