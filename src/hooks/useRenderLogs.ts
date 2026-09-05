import { createSignal, onCleanup } from 'solid-js';

const MAX_LOGS = 2000;
const FLUSH_EVERY = 10;
const FLUSH_DELAY_MS = 100;

/**
 * Capped log store for high-frequency FFmpeg output.
 *
 * Lines are batched in a plain array and flushed to the SolidJS signal in
 * batches (every {@link FLUSH_EVERY} lines, immediately for the first line,
 * or after {@link FLUSH_DELAY_MS} ms) so the LogViewer doesn't re-render on
 * every backend event.
 */
export function useRenderLogs() {
  const [logs, setLogs] = createSignal<string[]>([]);
  let buffer: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushLogs = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    setLogs((prev) => [...prev, ...batch].slice(-MAX_LOGS));
  };

  const appendLog = (line: string) => {
    buffer.push(line);
    if (
      buffer.length >= FLUSH_EVERY ||
      (logs().length === 0 && buffer.length === 1)
    ) {
      flushLogs();
    } else if (flushTimer === null) {
      flushTimer = setTimeout(flushLogs, FLUSH_DELAY_MS);
    }
  };

  const reset = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    buffer = [];
    setLogs([]);
  };

  onCleanup(() => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  });

  return { logs, appendLog, flush: flushLogs, reset };
}
