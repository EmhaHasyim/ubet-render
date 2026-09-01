/**
 * Shared log-level parsing for the SolidJS frontend.
 *
 * Two places need to know a log line's level:
 *
 *   1. `src/components/ui/LogLine.tsx` — picks the colour class
 *   2. `src/components/layout/LogViewer.tsx` — drives the filter chips
 *
 * Keeping the regex in one place guarantees those two sites never drift
 * (a line that's shown by the INFO chip stays text-info/80, and vice
 * versa).
 *
 * Constitutional design choices — must be preserved across both call
 * sites so each behaves as it did before this module existed:
 *
 * - **Bare-prefix collapse.** `[FATAL]` and bare `FATAL:`/`ERROR:`
 *   all map to `ERROR`. A user clicking the Error chip expects every
 *   "error-looking" line to disappear, not just bracketed ones.
 *
 * - **Null for unrecognized.** A line with no bracketed tag (and no
 *   bare error prefix) returns `null`. `LogLine` renders no colour for
 *   those lines (`<pre>` stays neutral); `LogViewer` treats them as
 *   "INFO" for filter-chip purposes, matching the historical "INFO is
 *   the catch-all bucket" behaviour documented in 0.2.3.
 */

/** Filter-chip category — only these three are user-toggleable. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

/** Order used by the filter-chip UI (left-to-right). */
export const FILTERABLE_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR'];

/**
 * Extract the log level from a line of pipeline output.
 *
 * Returns `null` if `text` does not carry a recognized bracket prefix
 * (`[INFO]`/`[WARN]`/`[ERROR]`/`[FATAL]`/`[SUCCESS]`) or a recognized
 * bare error prefix (`FATAL:` / `ERROR:` at start of string). Callers
 * decide how to interpret the null case:
 *   - `LogLine` renders no colour class
 *   - `LogViewer` treats `null` as belonging to the INFO chip
 */
export function parseLevel(text: string): LogLevel | null {
  if (text.includes('[SUCCESS]')) return 'SUCCESS';
  // FATAL brackets AND bare `FATAL:`/`ERROR:` prefixes all collapse to
  // ERROR — see constitutional comment above.
  if (
    text.includes('[ERROR]') ||
    text.includes('[FATAL]') ||
    /^(?:FATAL|ERROR):/i.test(text)
  )
    return 'ERROR';
  if (text.includes('[WARN]')) return 'WARN';
  if (text.includes('[INFO]')) return 'INFO';
  return null;
}
