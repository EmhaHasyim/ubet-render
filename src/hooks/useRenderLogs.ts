import { createSignal } from 'solid-js';
import { RingBuffer } from '../core/ringBuffer';

const MAX_LOGS = 2000;
const FLUSH_EVERY = 10;

/**
 * Ring-buffer-backed log store for high-frequency FFmpeg output.
 *
 * Lines are pushed into a pre-allocated ring buffer and flushed to the
 * SolidJS signal in batches (every {@link FLUSH_EVERY} lines, or immediately
 * for the first line) to avoid re-rendering the virtual-scrolled LogViewer
 * on every backend event.
 */
export function useRenderLogs() {
  const logBuffer = new RingBuffer<string>(MAX_LOGS);
  const [logs, setLogs] = createSignal<string[]>([]);
  const flushLogs = () => setLogs(logBuffer.toArray());
  let pushesSinceFlush = 0;

  const appendLog = (line: string) => {
    logBuffer.push(line);
    pushesSinceFlush += 1;
    if (pushesSinceFlush >= FLUSH_EVERY || logBuffer.length === 1) {
      pushesSinceFlush = 0;
      flushLogs();
    }
  };

  const reset = () => {
    logBuffer.reset();
    setLogs([]);
  };

  return { logs, appendLog, reset, logBuffer };
}
