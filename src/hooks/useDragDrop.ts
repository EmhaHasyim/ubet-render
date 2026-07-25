import { createSignal, onMount, onCleanup } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { MediaSource } from '../core/types';
import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from '../core/config';

type DropZone = 'video' | 'audio' | 'output';

/**
 * Map an (x, y) coordinate to the dropzone element underneath.
 * Shared by both Tauri native DnD and HTML5 fallback.
 */
function hitTestDropzone(x: number, y: number): DropZone | null {
  const el = document.elementFromPoint(x, y);
  if (el?.closest('#video-dropzone')) return 'video';
  if (el?.closest('#audio-dropzone')) return 'audio';
  if (el?.closest('#output-dropzone')) return 'output';
  return null;
}

/**
 * Filter an array of file paths to only those matching one of the given
 * extension arrays.  Used by both Tauri and HTML5 drop handlers.
 */
function filterPaths(paths: string[], extensions: string[]): string[] {
  return paths.filter((p) =>
    extensions.some((ext) => p.toLowerCase().endsWith(ext)),
  );
}

export function useDragDrop(
  updateVideoSource: (src: MediaSource) => void,
  updateAudioSource: (src: MediaSource) => void,
  updateOutputPath: (path: string) => void,
) {
  const [dragHover, setDragHover] = createSignal<DropZone | null>(null);
  let unlistenDrag: UnlistenFn | null = null;

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

    const zone = hitTestDropzone(e.clientX, e.clientY);

    if (zone === 'video') {
      const filtered = filterPaths(paths, VIDEO_EXTENSIONS);
      if (filtered.length > 0) {
        updateVideoSource({ type: 'files', paths: filtered });
      }
    } else if (zone === 'audio') {
      const filtered = filterPaths(paths, AUDIO_EXTENSIONS);
      if (filtered.length > 0) {
        updateAudioSource({ type: 'files', paths: filtered });
      }
    } else if (zone === 'output') {
      updateOutputPath(paths[0]);
    }
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
            const ratio = window.devicePixelRatio || 1;
            const x = event.payload.position.x / ratio;
            const y = event.payload.position.y / ratio;
            setDragHover(hitTestDropzone(x, y));
          } else if (event.payload.type === 'leave') {
            setDragHover(null);
          } else if (event.payload.type === 'drop') {
            setDragHover(null);
            const paths = event.payload.paths;
            if (paths.length === 0) return;

            const ratio = window.devicePixelRatio || 1;
            const x = event.payload.position.x / ratio;
            const y = event.payload.position.y / ratio;
            const zone = hitTestDropzone(x, y);

            if (zone === 'video') {
              const filtered = filterPaths(paths, VIDEO_EXTENSIONS);
              if (filtered.length > 0) {
                updateVideoSource({ type: 'files', paths: filtered });
              }
            } else if (zone === 'audio') {
              const filtered = filterPaths(paths, AUDIO_EXTENSIONS);
              if (filtered.length > 0) {
                updateAudioSource({ type: 'files', paths: filtered });
              }
            } else if (zone === 'output') {
              updateOutputPath(paths[0]);
            }
          }
        } catch (err) {
          console.error('[DragDrop] Tauri event handler error:', err);
        }
      });
    } catch (err) {
      console.error(
        '[DragDrop] Tauri DnD unavailable — will use HTML5 fallback:',
        err,
      );
    }
  });

  onCleanup(() => {
    // Cleanup Tauri native DnD listener
    if (unlistenDrag) {
      try {
        unlistenDrag();
      } catch {
        /* noop */
      }
    }

    // Cleanup HTML5 DnD listeners
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
  });

  return { dragHover };
}
