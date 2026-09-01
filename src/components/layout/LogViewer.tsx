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
import { safeSetStorageItem } from '../../core/storage';

// Height (px) of a single visual line in the monospace container at the
// `text-xs` size with `leading-relaxed` line-height.
const BASE_LINE_HEIGHT = 20;
const OVERSCAN = 15;
// Fallback monospace advance width at 12px (≈ 0.6 × font-size). Measured
// precisely at runtime; the constant covers test environments (jsdom) and
// fonts where measurement is unavailable.
const FALLBACK_CHAR_WIDTH = 7.2;
// Updated once on mount by {@link measureCharWidth}.
let charWidthPx = FALLBACK_CHAR_WIDTH;

/**
 * Measure the actual monospace advance width (px per char) so wrapped-line
 * height estimates stay accurate. Falls back to {@link FALLBACK_CHAR_WIDTH}
 * when measurement is unavailable.
 */
function measureCharWidth(): void {
  try {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;';
    probe.textContent = '0'.repeat(100);
    document.body.appendChild(probe);
    const measured = probe.getBoundingClientRect().width / 100;
    document.body.removeChild(probe);
    if (measured > 0) charWidthPx = measured;
  } catch {
    /* keep FALLBACK_CHAR_WIDTH */
  }
}

/**
 * Largest row index whose top edge is at or above `offset` px, given the
 * prefix sums of per-row heights. Returns `0` for an empty list.
 */
function findRowIndexAtOffset(sums: number[], offset: number): number {
  let lo = 0;
  let hi = sums.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sums[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const ALL_LEVELS: LogLevel[] = FILTERABLE_LEVELS;

interface LevelChipMeta {
  level: LogLevel;
  label: string;
  // DaisyUI `badge` color matching LogLine's text colour for visual continuity.
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

export function LogViewer(props: { logs: string[] }) {
  let containerRef!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [contentWidth, setContentWidth] = createSignal(0);
  const [shouldAutoScroll, setShouldAutoScroll] = createSignal(true);

  // ---- Filter / search state (persisted across tab switches) ----
  // Levels are stored as a comma-separated string in localStorage so the
  // filter survives mount/unmount cycles (tab switches).
  const readEnabledLevels = (): Set<LogLevel> => {
    try {
      const raw = localStorage.getItem('logs.filter.levels');
      if (raw) {
        const parsed = raw
          .split(',')
          .filter((l) => ALL_LEVELS.includes(l as LogLevel)) as LogLevel[];
        if (parsed.length > 0) return new Set(parsed);
      }
    } catch {
      /* quota / disabled */
    }
    return new Set(ALL_LEVELS);
  };
  const readSearchQuery = (): string => {
    try {
      return localStorage.getItem('logs.filter.query') ?? '';
    } catch {
      return '';
    }
  };

  const [enabledLevels, setEnabledLevels] =
    createSignal<Set<LogLevel>>(readEnabledLevels());
  const [searchQuery, setSearchQuery] = createSignal(readSearchQuery());
  let searchInputRef: HTMLInputElement | undefined;

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((cur) => {
      const next = new Set(cur);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      safeSetStorageItem('logs.filter.levels', [...next].join(','));
      return next;
    });
  };

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    safeSetStorageItem('logs.filter.query', value);
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
  //
  // Log lines can wrap (long ffmpeg progress lines in a narrow panel), so a
  // fixed per-entry height would misalign the padding-based scroller. Each
  // entry's height is instead estimated from its text length and the measured
  // monospace character width, and the visible window is found by binary
  // searching the prefix sums of those heights.

  // Approximate number of monospace characters that fit on one visual line.
  // `contentWidth` is the container's `clientWidth` (padding included), so
  // 24px (12px per side) is subtracted once to get the usable text width.
  const charsPerLine = createMemo(() => {
    const width = contentWidth();
    if (width <= 0) return 0;
    return Math.max(1, Math.floor((width - 24) / charWidthPx));
  });

  // Estimated rendered height of every filtered log entry (index-aligned
  // with `filteredLogs`). Wrapped entries are taller than one visual line.
  const rowHeights = createMemo(() => {
    const cpl = charsPerLine();
    return filteredLogs().map((line) => {
      const visualLines =
        cpl > 0 ? Math.max(1, Math.ceil(line.length / cpl)) : 1;
      return visualLines * BASE_LINE_HEIGHT;
    });
  });

  // Prefix sums of `rowHeights`: `sums[k]` = total height of entries [0, k).
  const prefixSums = createMemo(() => {
    const heights = rowHeights();
    const sums: number[] = Array.from({ length: heights.length + 1 }, () => 0);
    let acc = 0;
    sums[0] = 0;
    for (let i = 0; i < heights.length; i++) {
      acc += heights[i];
      sums[i + 1] = acc;
    }
    return sums;
  });

  const startIndex = () =>
    Math.max(0, findRowIndexAtOffset(prefixSums(), scrollTop()) - OVERSCAN);

  const endIndex = () => {
    // Before the viewport is measured (or in test environments with no
    // layout), render everything — matches the historical fallback.
    if (viewportHeight() <= 0) return filteredLogs().length;
    const sums = prefixSums();
    return Math.min(
      filteredLogs().length,
      findRowIndexAtOffset(sums, scrollTop() + viewportHeight()) + 1 + OVERSCAN,
    );
  };

  const visibleLogs = createMemo(() =>
    filteredLogs().slice(startIndex(), endIndex()),
  );
  const topPadding = () => prefixSums()[startIndex()];
  const bottomPadding = () => {
    const sums = prefixSums();
    return sums[filteredLogs().length] - sums[endIndex()];
  };

  const handleScroll = () => {
    if (!containerRef) return;
    setScrollTop(containerRef.scrollTop);

    // Detect whether the user is scrolled near the bottom so we know
    // whether to auto-scroll when new logs arrive.
    const el = containerRef;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShouldAutoScroll(distanceFromBottom < BASE_LINE_HEIGHT * 3);
  };

  // Track rAF ids so we can cancel on cleanup to avoid accessing
  // a stale containerRef after unmount.
  let rAFId = 0;

  // Measure the viewport and character width once on mount and on resize.
  onMount(() => {
    if (!containerRef) return;
    measureCharWidth();
    setViewportHeight(containerRef.clientHeight);
    setContentWidth(containerRef.clientWidth);

    const observer = new ResizeObserver(() => {
      // Use `clientWidth`/`clientHeight` (padding included) — the same source
      // as onMount — so the two paths stay consistent. `contentRect` would
      // exclude padding and break the `- 24` in `charsPerLine`.
      if (!containerRef) return;
      const newHeight = containerRef.clientHeight;
      const newWidth = containerRef.clientWidth;
      const prevWidth = contentWidth();

      // When the scrollbar appears or disappears the container's clientWidth
      // shifts by ~15-17 px (scrollbar gutter). That tiny change retriggers
      // the full virtual-scroll pipeline (charsPerLine → rowHeights →
      // prefixSums) and remaps the user's scroll position to different items,
      // causing visible content to jump. Skip the update when the delta is
      // small enough to be a scrollbar toggle rather than a real panel resize.
      if (prevWidth > 0 && Math.abs(newWidth - prevWidth) <= 18) {
        setViewportHeight(newHeight);
      } else {
        setViewportHeight(newHeight);
        setContentWidth(newWidth);
      }

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

    const id = requestAnimationFrame(() => {
      if (!containerRef) return;
      // Re-check shouldAutoScroll inside the rAF callback — by the time the
      // frame paints, a concurrent user scroll may have toggled it off.
      // Reading the signal here (not in the outer effect body) avoids a race
      // where new logs arrive between the user scrolling up and the next
      // handleScroll firing.
      if (!shouldAutoScroll()) return;
      containerRef.scrollTop = containerRef.scrollHeight;
      setScrollTop(containerRef.scrollTop);
    });
    onCleanup(() => cancelAnimationFrame(id));
  });

  return (
    <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      {/* ---- Header: title, level chips, search, count badge ---- */}
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
                onClick={async () => {
                  const text = props.logs.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                  } catch {
                    // Fallback for insecure contexts
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                  }
                }}
              >
                <Icon icon="lucide:clipboard-copy" width="12" height="12" />
                Copy all
              </button>
            </Show>
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
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
              <Show when={searchQuery().length > 0}>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-square absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label="Clear log filter"
                  onClick={() => {
                    handleSearchInput('');
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
        class="min-h-0 flex-1 overflow-y-auto border-t border-base-300/40 bg-base-200/60 p-3 font-mono text-xs leading-relaxed text-base-content/75 custom-scrollbar"
        onScroll={handleScroll}
      >
        <Show
          when={filteredLogs().length > 0}
          fallback={
            <Show
              when={props.logs.length > 0}
              fallback={
                <div class="py-10 text-center text-base-content/55">
                  Logs will appear here when you start a render.
                </div>
              }
            >
              <div class="py-10 text-center text-base-content/55">
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
