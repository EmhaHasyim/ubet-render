import { Show, createEffect } from 'solid-js';
import { rememberFocus } from '../../core/focus';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let dialogRef: HTMLDialogElement | undefined;
  // Captured when the dialog opens; restored the moment it closes so
  // keyboard / screen-reader users land back on the element that triggered
  // the dialog.
  let returnFocus: (() => void) | null = null;

  createEffect(() => {
    if (props.isOpen && dialogRef) {
      returnFocus = rememberFocus();
      dialogRef.showModal();
    } else if (!props.isOpen && dialogRef?.open) {
      // Parent flipped isOpen=false after a confirm/cancel callback.
      // Guard with `open` so we don't re-fire the close event for parents
      // that only update state on the confirm path.
      dialogRef.close();
    }
  });

  // Close event handler: only restores focus. We deliberately do NOT
  // call props.onCancel here — the buttons call it explicitly so the
  // dialog doesn't double-notify the parent when the parent also flips
  // isOpen=false in response to the same callback.
  const restoreFocusOnClose = () => {
    returnFocus?.();
    returnFocus = null;
  };

  // Buttons self-close the dialog so focus restoration works even when
  // the parent forgets to flip isOpen=false in response to the callback.
  const handleCancelClick = () => {
    if (dialogRef?.open) dialogRef.close();
    props.onCancel();
  };

  const handleConfirmClick = () => {
    if (dialogRef?.open) dialogRef.close();
    props.onConfirm();
  };

  return (
    <Show when={props.isOpen}>
      <dialog ref={dialogRef} class="modal" onClose={restoreFocusOnClose}>
        <div class="modal-box">
          <h3 class="text-lg font-semibold">{props.title}</h3>
          <p class="py-4 text-sm text-base-content/70">{props.message}</p>
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={handleCancelClick}
            >
              {props.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              class="btn btn-error btn-sm"
              data-testid="confirm-dialog-confirm"
              onClick={handleConfirmClick}
            >
              {props.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>
    </Show>
  );
}
