/**
 * Lightweight in-app toast notification store.
 *
 * Distinct from `src/core/notify.ts`, which sends OS-level notifications
 * (Windows toast / macOS Notification Center / Linux libnotify). Use this
 * module for short, ephemeral feedback that should appear *inside* the app
 * (e.g. after triggering Pause, Resume, or Cancel), even when the window is
 * focused and the user is interacting with the UI.
 *
 * The store uses a single SolidJS signal at module scope. `For` can be used
 * to render the list reactively — no createRoot needed because nothing here
 * uses createEffect at the module top level.
 */

import { createSignal } from 'solid-js';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  ttl: number;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);

let nextId = 0;
const genId = (): number => {
  nextId += 1;
  return nextId;
};

// Track auto-dismiss timers so manual dismiss clears them (no leaked
// `setTimeout` firing `dismissToast` for an already-removed id).
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Reset module state — test-only. */
export function resetToastsForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  nextId = 0;
  setToasts([]);
}

export interface ToastOptions {
  /** Visual variant. Defaults to `'info'`. */
  variant?: ToastVariant;
  /** Time-to-live in ms before auto-dismiss. Default 3500. Pass 0 to make sticky. */
  ttl?: number;
}

/**
 * Show a toast.
 * @returns The toast id (pass to {@link dismissToast} to dismiss early).
 */
export function showToast(message: string, options: ToastOptions = {}): number {
  const ttl = options.ttl ?? 3500;
  const id = genId();
  setToasts((cur) => [
    ...cur,
    {
      id,
      message,
      variant: options.variant ?? 'info',
      ttl,
    },
  ]);
  if (ttl > 0) {
    const timer = setTimeout(() => {
      timers.delete(id);
      dismissToast(id);
    }, ttl);
    timers.set(id, timer);
  }
  return id;
}

/** Manually dismiss a toast by id (e.g. user clicked the X button). */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  setToasts((cur) =>
    cur.some((t) => t.id === id) ? cur.filter((t) => t.id !== id) : cur,
  );
}

/** Reactive accessor for the current toast queue. */
export function useToasts(): () => Toast[] {
  return toasts;
}
