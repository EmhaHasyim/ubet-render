/**
 * Pure dropzone logic: coordinate/element → zone mapping and drop dispatch.
 *
 * Framework- and DOM-free on purpose (no `document`, no SolidJS, no Tauri)
 * so it runs under `// @vitest-environment node` and in any DOM simulator
 * without layout stubs. `useDragDrop` is a thin adapter that feeds browser
 * hit-test results into these functions — see that hook for the wiring.
 */

import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from './config';

export type DropZone = 'video' | 'audio' | 'output';

/** DOM ids of the three drop targets (single source of truth). */
export const ZONE_IDS: Record<DropZone, string> = {
  video: 'video-dropzone',
  audio: 'audio-dropzone',
  output: 'output-dropzone',
};

/** Minimal shape needed for zone lookup (satisfied by `Element.closest`). */
export interface ClosestElement {
  closest(selector: string): unknown;
}

/**
 * Map a hit-tested element to its dropzone. Returns `null` outside zones.
 * Pure: pass `document.elementFromPoint(x, y)` (or a test double) in.
 */
export function zoneFromElement(
  el: ClosestElement | null | undefined,
): DropZone | null {
  if (!el) return null;
  if (el.closest(`#${ZONE_IDS.video}`)) return 'video';
  if (el.closest(`#${ZONE_IDS.audio}`)) return 'audio';
  if (el.closest(`#${ZONE_IDS.output}`)) return 'output';
  return null;
}

/** Keep only paths matching one of the given extensions (case-insensitive). */
export function filterPathsByExt(
  paths: readonly string[],
  extensions: readonly string[],
): string[] {
  return paths.filter((p) =>
    extensions.some((ext) => p.toLowerCase().endsWith(ext)),
  );
}

export type DropAction =
  | { kind: 'video' | 'audio'; paths: string[] }
  | { kind: 'output'; path: string }
  | { kind: 'ignore' };

/**
 * Decide what a drop does, given already-resolved paths and zone.
 * Mirrors the historical `dispatchDrop` branching exactly:
 * - video/audio: keep matching extensions, ignore when none match;
 * - output: take the first path;
 * - empty paths or no zone: ignore.
 */
export function dispatchDropPaths(
  paths: readonly string[],
  zone: DropZone | null,
): DropAction {
  if (paths.length === 0 || zone === null) return { kind: 'ignore' };
  if (zone === 'video') {
    const filtered = filterPathsByExt(paths, VIDEO_EXTENSIONS);
    return filtered.length > 0
      ? { kind: 'video', paths: filtered }
      : { kind: 'ignore' };
  }
  if (zone === 'audio') {
    const filtered = filterPathsByExt(paths, AUDIO_EXTENSIONS);
    return filtered.length > 0
      ? { kind: 'audio', paths: filtered }
      : { kind: 'ignore' };
  }
  const firstPath = paths[0];
  return firstPath ? { kind: 'output', path: firstPath } : { kind: 'ignore' };
}

/** Scale raw event coordinates by the device pixel ratio (Tauri reports physical pixels). */
export function scalePoint(
  x: number,
  y: number,
  ratio: number,
): { x: number; y: number } {
  const r = ratio || 1;
  return { x: x / r, y: y / r };
}
