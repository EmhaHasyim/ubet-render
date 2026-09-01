import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { LogLine } from '../ui/LogLine';
import { LogToolbar } from './LogToolbar';
import { useLogFilter } from '../../hooks/useLogFilter';
import { useVirtualScroller } from '../../hooks/useVirtualScroller';

const BASE_LINE_HEIGHT = 20;

export function LogViewer(props: { logs: string[] }) {
  let containerRef!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [contentWidth, setContentWidth] = createSignal(0);
  const [shouldAutoScroll, setShouldAutoScroll] = createSignal(true);

  const filter = useLogFilter(() => props.logs);
  const {
    enabledLevels,
    searchQuery,
    filteredLogs,
    isFiltering,
    toggleLevel,
    handleSearchInput,
  } = filter;
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
  const virtualScroller = useVirtualScroller(
    filteredLogs,
    scrollTop,
    viewportHeight,
    contentWidth,
  );
  const { measureCharWidth, visibleLogs, topPadding, bottomPadding } =
    virtualScroller;

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
      <LogToolbar
        logs={props.logs}
        controls={{
          enabledLevels,
          searchQuery,
          filteredCount: () => filteredLogs().length,
          isFiltering,
          toggleLevel,
          handleSearchInput,
        }}
      />

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
