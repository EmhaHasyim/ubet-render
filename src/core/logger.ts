/**
 * Centralized logger for the SolidJS frontend.
 *
 * Replaces the 11 `console.error` / `console.warn` call sites that were
 * scattered across the production codebase with a single namespaced
 * abstraction. Each call site gets a pre-bound context label (file /
 * module name), so messages are easy to grep and easy to forward to a
 * sink other than `window.console` (e.g. a Tauri-managed file) without
 * touching call sites.
 *
 * Output format (mirrors `src-tauri/src/utils/logger.rs` which writes the
 * backend log to disk):
 *   `[2026-07-25 14:23:01.234] [usePipeline] Hardware detection failed`
 *
 * Each logged line is also pushed to a small in-memory queue and flushed
 * to the backend `log_to_file` command on a 500 ms debounce. The flush
 * is fire-and-forget — if the IPC channel is unavailable (tests, browser
 * dev mode) the line still appears in the browser console because the
 * console dispatch is synchronous and happens first.
 */

import { invoke } from '@tauri-apps/api/core';
import { TAURI_COMMANDS } from './constants';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---- File sink batching ------------------------------------------------

interface FrontendLogEntry {
  level: Level;
  context: string;
  message: string;
}

/** Max ms to wait before flushing buffered entries — coalesces high
 *  frequency log traffic (e.g. during busy FFmpeg progress streams). */
const BATCH_FLUSH_DELAY = 500;

/** Cap-driven early flush: prevents the buffer from growing unboundedly
 *  if logs arrive faster than the debounce timer can fire. */
const BATCH_MAX_SIZE = 100;

const logBatch: FrontendLogEntry[] = [];
let pendingFlush: ReturnType<typeof setTimeout> | null = null;

const flushBatch = (): void => {
  if (logBatch.length === 0) return;
  const batch = logBatch.splice(0, logBatch.length);
  // Fire-and-forget: a failed IPC call must NOT abort the user-facing
  // console dispatch that already happened synchronously above this
  // function. The IP / WebView will surface the line regardless.
  invoke(TAURI_COMMANDS.logToFile, { entries: batch }).catch(() => {});
};

const scheduleFlush = (): void => {
  if (pendingFlush !== null) return;
  pendingFlush = setTimeout(() => {
    pendingFlush = null;
    flushBatch();
  }, BATCH_FLUSH_DELAY);
};

const dispatchToFile = (
  level: Level,
  context: string,
  message: string,
): void => {
  logBatch.push({ level, context, message });
  if (logBatch.length >= BATCH_MAX_SIZE) {
    flushBatch();
  } else {
    scheduleFlush();
  }
};

// ---- Formatting helpers ----------------------------------------------

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    // Circular references, BigInt, etc.
    return String(value);
  }
}

// Hoisted to module scope so they're allocated once. (Was previously
// recreated on every `formatTimestamp()` call — flagged by
// `unicorn/consistent-function-scoping`.)
const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad3 = (n: number): string => String(n).padStart(3, '0');

function formatTimestamp(): string {
  // UTC, fixed-width precision so a `tail -f` of both frontend
  // console lines and the backend render log lines up by clock.
  // Mirrors `chrono::Utc::now().format("%H:%M:%S%.3f")` in
  // `src-tauri/src/utils/logger.rs::log_line`.
  //
  // NOTE: uses getUTC* so timestamps are timezone-agnostic and
  // always match the Rust backend (which also logs in UTC).
  const d = new Date();
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`
  );
}

/**
 * Create a namespaced logger. The `context` label is prepended to every
 * message, e.g. `createLogger('usePipeline')` produces lines like
 * `[2026-07-25 14:23:01.234] [usePipeline] ...`.
 */
export function createLogger(context: string): Logger {
  const log = (level: Level, args: unknown[]): void => {
    const messageParts: string[] = [];
    for (const a of args) {
      if (a instanceof Error) {
        // Drop a leading "Error: " prefix from a.message (the default
        // toString output already includes it; we don't want it twice).
        const msg = a.message.startsWith('Error: ')
          ? a.message.slice('Error: '.length)
          : a.message;
        messageParts.push(a.stack ? `${msg}\n${a.stack}` : msg);
      } else {
        messageParts.push(safeStringify(a));
      }
    }

    const line = `[${formatTimestamp()}] [${context}] ${messageParts.join(' ')}`;
    // Sync console dispatch is the user-facing fallback that MUST run
    // first so the line is visible regardless of IPC availability.
    (console as Record<Level, (...a: unknown[]) => void>)[level](line);

    // Forward to the persistent backend file sink (debounced, best-effort).
    dispatchToFile(level, context, messageParts.join(' '));
  };

  return {
    debug: (...args) => log('debug', args),
    info: (...args) => log('info', args),
    warn: (...args) => log('warn', args),
    error: (...args) => log('error', args),
  };
}
