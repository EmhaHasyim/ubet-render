import { Show, createSignal, createEffect } from 'solid-js';
import { Icon } from '../ui/Icon';
import { rememberFocus } from '../../core/focus';

export function AppHeader(props: {
  running: boolean;
  paused: boolean;
  onStart: (resume: boolean) => void;
  onResume: () => void;
  onCancel: () => void;
  onPause: () => void;
  canStart: boolean;
  disabledReason?: string;
  /**
   * Human-readable render estimate shown near the Start button.
   * Example: "~45 videos · ~12 min each ≃ 9 hours". Pass undefined to hide.
   */
  renderEstimate?: string;
}) {
  const [showCancelDialog, setShowCancelDialog] = createSignal(false);
  // Track whether the cancel was triggered from the paused state so the
  // dialog text can reflect the actual situation (FFmpeg is already stopped
  // when paused, so there is no active process to kill).
  const [cancelFromPaused, setCancelFromPaused] = createSignal(false);
  let cancelModalRef: HTMLDialogElement | undefined;
  // Captured in the show-effect below; consumed by the close-handler so the
  // opener button (or whatever had focus before showModal()) regains focus
  // after the dialog closes — standard a11y pattern.
  let returnFocus: (() => void) | null = null;

  createEffect(() => {
    // Show the dialog as soon as it enters the DOM; close on signal toggle.
    if (showCancelDialog() && cancelModalRef) {
      returnFocus = rememberFocus();
      cancelModalRef.showModal();
    } else if (!showCancelDialog() && cancelModalRef?.open) {
      cancelModalRef.close();
    }
  });

  // Close event: only restore focus. The "Keep rendering" backdrop button
  // flips showCancelDialog=false via <form method="dialog">, so this
  // fires for both ESC and backdrop click.
  const restoreFocusOnClose = () => {
    returnFocus?.();
    returnFocus = null;
  };

  const confirmCancel = () => {
    // Self-close so the dialog's `close` event fires and restoreFocusOnClose
    // runs to restore the opener's focus. We don't need to call returnFocus
    // imperatively here — the close event flushes synchronously per the
    // dialog polyfill and the handler covers it.
    if (cancelModalRef?.open) cancelModalRef.close();
    setShowCancelDialog(false);
    props.onCancel();
  };

  return (
    <>
      <section class="panel">
        <div class="card-body p-4">
          <div class="flex items-start gap-3">
            <div
              class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-base-300/50 ${props.running ? 'text-info' : props.paused ? 'text-warning' : 'text-primary'}`}
            >
              <Icon
                icon={
                  props.running
                    ? 'lucide:loader-2'
                    : props.paused
                      ? 'lucide:pause-circle'
                      : 'lucide:play'
                }
                class={props.running ? 'motion-safe:animate-spin' : ''}
                width="20"
                height="20"
              />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold">
                {props.running
                  ? 'Rendering batch'
                  : props.paused
                    ? 'Render paused'
                    : 'Ready'}
              </h3>
              <p class="mt-0.5 text-[13px] text-base-content/50">
                {props.running
                  ? 'Batch in progress.'
                  : props.paused
                    ? 'Render is paused.'
                    : props.canStart
                      ? 'All paths set.'
                      : 'Missing paths.'}
              </p>
            </div>
          </div>

          <div class="mt-4 flex flex-col gap-2 transition-opacity duration-200">
            <Show when={!props.running && !props.paused}>
              <div
                class={
                  !props.canStart ? 'tooltip tooltip-bottom w-full' : 'w-full'
                }
                data-tip={
                  !props.canStart && props.disabledReason
                    ? props.disabledReason
                    : undefined
                }
              >
                <button
                  type="button"
                  class="btn btn-primary w-full gap-2"
                  disabled={!props.canStart}
                  onClick={() => props.onStart(false)}
                >
                  <Icon icon="lucide:play" width="18" height="18" />
                  Start new batch
                </button>
                {props.renderEstimate && (
                  <p class="mt-1.5 text-center text-xs text-base-content/50">
                    {props.renderEstimate}
                  </p>
                )}
              </div>
            </Show>

            <Show when={!props.running && props.paused}>
              <div class="flex flex-col gap-2 animate-fadeIn">
                <button
                  type="button"
                  class="btn btn-primary w-full gap-2"
                  onClick={() => props.onResume()}
                >
                  <Icon icon="lucide:play-circle" width="18" height="18" />
                  Resume render
                </button>

                <button
                  type="button"
                  class="btn btn-outline btn-error w-full gap-2"
                  onClick={() => {
                    setCancelFromPaused(true);
                    setShowCancelDialog(true);
                  }}
                >
                  <Icon icon="lucide:circle-stop" width="18" height="18" />
                  Cancel render
                </button>
              </div>
            </Show>

            <Show when={props.running}>
              <div class="flex flex-col gap-2 animate-fadeIn">
                <button
                  type="button"
                  class="btn btn-info w-full gap-2"
                  onClick={props.onPause}
                >
                  <Icon icon="lucide:pause" width="18" height="18" />
                  Pause render
                </button>

                <button
                  type="button"
                  class="btn btn-outline btn-error w-full gap-2"
                  onClick={() => {
                    setCancelFromPaused(false);
                    setShowCancelDialog(true);
                  }}
                >
                  <Icon icon="lucide:circle-stop" width="18" height="18" />
                  Cancel render
                </button>
              </div>
            </Show>
          </div>
        </div>
      </section>

      <Show when={showCancelDialog()}>
        <dialog
          ref={cancelModalRef}
          class="modal modal-bottom sm:modal-middle"
          onClose={() => {
            setShowCancelDialog(false);
            restoreFocusOnClose();
          }}
        >
          <div class="modal-box rounded-xl border border-error/20 bg-base-100">
            <h3 class="flex items-center gap-2 text-lg font-semibold text-error">
              <Icon icon="lucide:triangle-alert" width="20" height="20" />
              Cancel render?
            </h3>
            <p class="py-4 text-sm text-base-content/70">
              {cancelFromPaused()
                ? 'The render is currently paused. Cancelling will discard all progress and you will need to start over.'
                : 'The current FFmpeg process will stop and unfinished output for the active job may be incomplete.'}
            </p>
            <div class="modal-action mt-0">
              <form method="dialog">
                <button class="btn btn-ghost">
                  {cancelFromPaused() ? 'Keep paused' : 'Keep rendering'}
                </button>
              </form>
              <button class="btn btn-error" onClick={confirmCancel}>
                Cancel render
              </button>
            </div>
          </div>
          <form method="dialog" class="modal-backdrop">
            <button>close</button>
          </form>
        </dialog>
      </Show>
    </>
  );
}
