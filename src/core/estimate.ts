/**
 * Pure, framework-agnostic helpers used by the render pipeline.
 * Kept separate from the SolidJS hook so they can be unit-tested without Tauri.
 */

import { CONFIG_LIMITS } from './schema';

const { min: MIN_BITRATE_K, max: MAX_BITRATE_K } = CONFIG_LIMITS.bitrateK;

/**
 * Normalize a bitrate value to the "4000k" format used throughout the app.
 * Accepts "5000", "5000k", "5000K", etc. and returns "5000k".
 * If the input is not a valid bitrate, returns it unchanged for the user to fix.
 */
export function normalizeBitrate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(?:[kK].*)?$/);
  if (!match) return value;
  const digits = match[1];
  return digits === undefined ? value : `${digits}k`;
}

/**
 * Validate a bitrate string such as "4000" or "4000k" (plain integer,
 * optionally with a `k` suffix).
 * Returns `true` when the value is a valid bitrate within the allowed range
 * (100 – 50 000 kbps), matching the backend's validation in `validate_bitrate`.
 */
export function isMaxrateValid(value: string): boolean {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(?:k|K)?$/);
  if (!match) return false;
  const digits = match[1];
  if (digits === undefined) return false;
  const k = parseInt(digits, 10);
  return Number.isFinite(k) && k >= MIN_BITRATE_K && k <= MAX_BITRATE_K;
}

/** Format a millisecond duration as a short, human-readable ETA string.
 *  Rounds seconds up to avoid the "0s" display for sub-second remainders
 *  and collapses sub-minute durations to "< 1m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);

  // Collapse sub-minute leftovers to avoid displaying "0s" — an ETA of
  // "5m 0s" is noise; "5m" is clearer. Same for exact hours: "5h 0m" is
  // noise, "5h" is clearer.
  if (h > 0 && m > 0) return `${h}h ${m}m left`;
  if (h > 0) return `${h}h left`;
  if (m > 0) return `${m}m left`;
  return '< 1m left';
}
