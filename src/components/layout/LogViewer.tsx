import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { Icon } from '../ui/Icon';
import { LogLine } from '../ui/LogLine';
import { LogToolbar } from './LogToolbar';
import { useLogFilter } from '../../hooks/useLogFilter';

const BASE_LINE_HEIGHT = 20;

export function LogViewer(props: { logs: string[] }) {
  let containerRef!: HTMLDivElement;
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

  // Reset scroll position ONLY on coarse-grained filter changes (chip
  // toggle). Tracking `filteredLogs()` directly would fire on every raw log
  // line — yanking the user back to the top mid-inspect every time ffmpeg
  // emits a newline; tracking `searchQuery()` would fire on every keystroke.
  createEffect(() => {
    enabledLevels();
    if (containerRef) containerRef.scrollTop = 0;
  });

  const handleScroll = () => {
    if (!containerRef) return;
    // Detect whether the user is scrolled near the bottom so we know
    // whether to auto-scroll when new logs arrive.
    const el = containerRef;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShouldAutoScroll(distanceFromBottom < BASE_LINE_HEIGHT * 3);
  };

  // Track rAF ids so we can cancel on cleanup to avoid accessing
  // a stale containerRef after unmount.
  let rAFId = 0;

  // Keep the view pinned to the bottom on resize while auto-scrolling.
  onMount(() => {
    const observer = new ResizeObserver(() => {
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
          <For each={filteredLogs()}>{(line) => <LogLine text={line} />}</For>
        </Show>
      </div>
    </section>
  );
}
