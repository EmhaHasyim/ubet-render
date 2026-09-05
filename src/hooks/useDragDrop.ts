import { createSignal, onMount, onCleanup } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { MediaSource } from '../core/types';
import {
  dispatchDropPaths,
  scalePoint,
  zoneFromElement,
  type DropZone,
} from '../core/dropZones';
import { createLogger } from '../core/logger';

// Replaces 2 ad-hoc console.error calls; see `src/core/logger.ts`.
const log = createLogger('DragDrop');

export type { DropZone } from '../core/dropZones';

/**
 * Map an (x, y) coordinate to the dropzone element underneath.
 * Thin adapter over the pure `zoneFromElement` — the only DOM touchpoint,
 * shared by both Tauri native DnD and HTML5 fallback.
 */
function hitTestDropzone(x: number, y: number): DropZone | null {
  return zoneFromElement(document.elementFromPoint(x, y));
}

export function useDragDrop(
  updateVideoSource: (src: MediaSource) => void,
  updateAudioSource: (src: MediaSource) => void,
  updateOutputPath: (path: string) => void,
) {
  const [dragHover, setDragHover] = createSignal<DropZone | null>(null);
  let unlistenDrag: UnlistenFn | null = null;

  // Single dispatch shared by HTML5 and Tauri-native drop handlers.
  // Zone/extension branching lives in the pure `dispatchDropPaths`
  // (`src/core/dropZones.ts`); this only forwards the resulting action.
  const dispatchDrop = (paths: string[], x: number, y: number): void => {
    const action = dispatchDropPaths(paths, hitTestDropzone(x, y));
    if (action.kind === 'video') {
      updateVideoSource({ type: 'files', paths: action.paths });
    } else if (action.kind === 'audio') {
      updateAudioSource({ type: 'files', paths: action.paths });
    } else if (action.kind === 'output') {
      updateOutputPath(action.path);
    }
  };

  // ------------------------------------------------------------------
  // HTML5 drag-and-drop fallback handlers (used when running in the
  // browser during development / `vite dev` outside of the Tauri
  // webview).
  // ------------------------------------------------------------------
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    e.dataTransfer.dropEffect = 'copy';

    const zone = hitTestDropzone(e.clientX, e.clientY);
    setDragHover(zone);
  };

  const onDragLeave = (e: DragEvent) => {
    // Only clear hover when actually leaving the dropzone area.
    const zone = hitTestDropzone(e.clientX, e.clientY);
    if (!zone) setDragHover(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragHover(null);
    if (!e.dataTransfer) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Extract paths: Tauri-injected `file.path` if available,
    // otherwise fall back to `file.name` for browser dev mode.
    const paths: string[] = files.map((f) => {
      // `path` is a non-standard property added by Tauri/Electron
      // which is `any` typed, so we cast via `as unknown`.
      return ((f as unknown as Record<string, string>).path ||
        f.name) as string;
    });

    dispatchDrop(paths, e.clientX, e.clientY);
  };

  // ------------------------------------------------------------------
  // Single onMount: set up BOTH Tauri native DnD AND HTML5 fallback.
  // HTML5 listeners are no-ops in Tauri because the webview intercepts
  // OS-level drag events before they reach the DOM.
  // ------------------------------------------------------------------
  onMount(async () => {
    // ── HTML5 fallback listeners ──────────────────────────────────
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    // ── Tauri native DnD (primary) ───────────────────────────────
    try {
      const appWindow = getCurrentWindow();
      unlistenDrag = await appWindow.onDragDropEvent((event) => {
        try {
          if (event.payload.type === 'over' || event.payload.type === 'enter') {
            const { x, y } = scalePoint(
              event.payload.position.x,
              event.payload.position.y,
              window.devicePixelRatio || 1,
            );
            setDragHover(hitTestDropzone(x, y));
          } else if (event.payload.type === 'leave') {
            setDragHover(null);
          } else if (event.payload.type === 'drop') {
            setDragHover(null);
            const paths = event.payload.paths;
            const { x, y } = scalePoint(
              event.payload.position.x,
              event.payload.position.y,
              window.devicePixelRatio || 1,
            );
            dispatchDrop(paths, x, y);
          }
        } catch (err) {
          log.error('Tauri event handler error:', err);
        }
      });
    } catch (err) {
      log.error('Tauri DnD unavailable — will use HTML5 fallback:', err);
    }
  });

  onCleanup(() => {
    // Cleanup Tauri native DnD listener
    if (unlistenDrag) {
      try {
        unlistenDrag();
      } catch (err) {
        log.warn('unlisten drag-drop failed:', err);
      }
    }

    // Cleanup HTML5 DnD listeners
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
  });

  return { dragHover };
}
