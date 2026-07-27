/**
 * Focus restoration utility for modal dialogs.
 *
 * When a modal opens (HTMLDialogElement.showModal()) the browser moves focus
 * into the dialog. When the modal closes (close() / ESC / backdrop click), the
 * browser restores focus to whatever element had focus *before* showModal —
 * but only for the *default* focus ring path. If focus was set imperatively
 * inside the dialog before close, or if user navigates with keyboard and the
 * opener is no longer the previous activeElement, focus is lost to <body>.
 *
 * This utility captures the document.activeElement at call-time and returns
 * a function that refocuses it later. Use it immediately before
 * `showModal()` and call the returned callback from the dialog's onClose
 * handler.
 *
 * @example
 * ```tsx
 * const returnFocus = rememberFocus();
 * dialog.showModal();
 * // later, on dialog 'close' event:
 * returnFocus();
 * ```
 */
export function rememberFocus(): () => void {
  // Snapshot the element that currently has focus; if it's the body or null
  // (e.g. due to programmatic focus earlier), we still return a no-op rather
  // than throwing.
  const el =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  return () => {
    // Skip if the captured node was removed from the DOM (e.g. parent component
    // unmounted) — focusing a detached element throws nowhere but logs a
    // confusing console warning.
    if (!el || !document.body.contains(el)) return;
    // Some elements have visibility:hidden / aria-hidden ancestors and would
    // silently drop the focus request. Best-effort: ignore failures silently.
    try {
      el.focus();
    } catch {
      /* noop */
    }
  };
}
