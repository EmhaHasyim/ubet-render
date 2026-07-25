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

// Estimated height (px) of a single log line in the monospace container.
// Used by the virtual scroller to calculate the visible window.
const ROW_HEIGHT = 20;
const OVERSCAN = 15;

export function LogViewer(props: { logs: string[] }) {
  let containerRef!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [shouldAutoScroll, setShouldAutoScroll] = createSignal(true);

  // ---- Virtual scrolling math ----
  const startIndex = () =>
    Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);

  const visibleCount = () =>
    viewportHeight() > 0
      ? Math.ceil(viewportHeight() / ROW_HEIGHT) + OVERSCAN * 2
      : props.logs.length; // fallback: render all until viewport measured

  const endIndex = () =>
    Math.min(props.logs.length, startIndex() + visibleCount());

  const visibleLogs = createMemo(() =>
    props.logs.slice(startIndex(), endIndex()),
  );
  const topPadding = () => startIndex() * ROW_HEIGHT;
  const bottomPadding = () => (props.logs.length - endIndex()) * ROW_HEIGHT;

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
    props.logs;
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
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center justify-between border-b border-base-300 px-4 py-3 shrink-0">
          <div class="flex items-center gap-2">
            <Icon
              icon="lucide:terminal"
              class="text-primary"
              width="18"
              height="18"
            />
            <h3 class="font-semibold">Logs</h3>
          </div>
          <span class="badge badge-ghost badge-sm">{props.logs.length}</span>
        </div>

        <div
          ref={containerRef}
          class="min-h-0 flex-1 overflow-y-auto bg-neutral p-3 font-mono text-xs leading-relaxed text-neutral-content custom-scrollbar"
          onScroll={handleScroll}
        >
          <Show
            when={props.logs.length > 0}
            fallback={
              <div class="py-10 text-center text-neutral-content/65">
                No log output yet.
              </div>
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
              <For each={visibleLogs()}>
                {(line) => <LogLine text={line} />}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </section>
  );
}
