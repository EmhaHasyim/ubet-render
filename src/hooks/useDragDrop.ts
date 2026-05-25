import { createSignal, onMount, onCleanup } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { MediaSource } from '../core/types';

export function useDragDrop(
  updateVideoSource: (src: MediaSource) => void,
  updateAudioSource: (src: MediaSource) => void,
  updateOutputPath: (path: string) => void,
) {
  const [dragHover, setDragHover] = createSignal<
    'video' | 'audio' | 'output' | null
  >(null);
  let unlistenDrag: UnlistenFn | null = null;

  onMount(async () => {
    try {
      const appWindow = getCurrentWindow();
      unlistenDrag = await appWindow.onDragDropEvent((event) => {
        if (event.payload.type === 'over' || event.payload.type === 'enter') {
          const x = event.payload.position.x;
          const y = event.payload.position.y;
          const el = document.elementFromPoint(x, y);
          if (el?.closest('#video-dropzone')) setDragHover('video');
          else if (el?.closest('#audio-dropzone')) setDragHover('audio');
          else if (el?.closest('#output-dropzone')) setDragHover('output');
          else setDragHover(null);
        } else if (event.payload.type === 'leave') {
          setDragHover(null);
        } else if (event.payload.type === 'drop') {
          setDragHover(null);
          const paths = event.payload.paths;
          if (paths.length === 0) return;

          const x = event.payload.position.x;
          const y = event.payload.position.y;
          const el = document.elementFromPoint(x, y);

          if (el?.closest('#video-dropzone')) {
            updateVideoSource({ type: 'files', paths });
          } else if (el?.closest('#audio-dropzone')) {
            updateAudioSource({ type: 'files', paths });
          } else if (el?.closest('#output-dropzone')) {
            updateOutputPath(paths[0]);
          }
        }
      });
    } catch {}
  });

  onCleanup(() => {
    if (unlistenDrag) unlistenDrag();
  });

  return { dragHover };
}
