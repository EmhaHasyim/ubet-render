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
 * Future work: a `log_to_file` Tauri command can be invoked from the
 * `dispatch` step without changing any call-site signature. Until then,
 * the logger routes only to the browser console.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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

function formatTimestamp(): string {
  // Local time, fixed-width precision so a `tail -f` of both frontend
  // console lines and the backend render log lines up by clock.
  // Mirrors `chrono::Utc::now().format("%H:%M:%S%.3f")` in
  // `src-tauri/src/utils/logger.rs::log_line`.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const padMs = (n: number) => String(n).padStart(3, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`
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
    // This module IS the abstraction; using bare `console` here
    // deliberately bypasses any recursive logger invocation. Future
    // swap to a file sink happens entirely inside this function.
    (console as Record<Level, (...a: unknown[]) => void>)[level](line);
  };

  return {
    debug: (...args) => log('debug', args),
    info: (...args) => log('info', args),
    warn: (...args) => log('warn', args),
    error: (...args) => log('error', args),
  };
}
