import { Show, createEffect } from 'solid-js';

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

  createEffect(() => {
    if (props.isOpen && dialogRef) {
      dialogRef.showModal();
    } else if (!props.isOpen && dialogRef?.open) {
      dialogRef.close();
    }
  });

  return (
    <Show when={props.isOpen}>
      <dialog ref={dialogRef} class="modal" onClose={props.onCancel}>
        <div class="modal-box">
          <h3 class="text-lg font-semibold">{props.title}</h3>
          <p class="py-4 text-sm text-base-content/70">{props.message}</p>
          <div class="modal-action">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={props.onCancel}
            >
              {props.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              class="btn btn-error btn-sm"
              data-testid="confirm-dialog-confirm"
              onClick={props.onConfirm}
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
