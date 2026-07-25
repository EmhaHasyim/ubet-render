import { Show, createSignal, createEffect } from 'solid-js';
import { Icon } from '@iconify-icon/solid';

export function AppHeader(props: {
  running: boolean;
  paused: boolean;
  onStart: (resume: boolean) => void;
  onResume: () => void;
  onCancel: () => void;
  onPause: () => void;
  canStart: boolean;
  disabledReason?: string;
}) {
  const [showCancelDialog, setShowCancelDialog] = createSignal(false);
  let cancelModalRef: HTMLDialogElement | undefined;

  createEffect(() => {
    // Show the dialog as soon as it enters the DOM; close on signal toggle.
    if (showCancelDialog() && cancelModalRef) {
      cancelModalRef.showModal();
    } else if (!showCancelDialog() && cancelModalRef?.open) {
      cancelModalRef.close();
    }
  });

  const confirmCancel = () => {
    props.onCancel();
    if (cancelModalRef) cancelModalRef.close();
    // 'close' event → onClose → setShowCancelDialog(false) already handles cleanup
  };

  return (
    <>
      <section class="panel">
        <div class="card-body p-4">
          <div class="flex items-start gap-3">
            <div
              class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${props.running ? 'bg-warning/15 text-warning' : props.paused ? 'bg-info/15 text-info' : 'bg-primary/10 text-primary'}`}
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
              <h3 class="font-semibold">
                {props.running
                  ? 'Rendering batch'
                  : props.paused
                    ? 'Render paused'
                    : 'Ready'}
              </h3>
              <p class="mt-1 text-sm text-base-content/60">
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
              </div>
            </Show>

            <Show when={!props.running && props.paused}>
              <button
                type="button"
                class="btn btn-primary w-full gap-2"
                onClick={() => props.onResume()}
              >
                <Icon icon="lucide:play-circle" width="18" height="18" />
                Resume render
              </button>
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
                  onClick={() => setShowCancelDialog(true)}
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
          onClose={() => setShowCancelDialog(false)}
        >
          <div class="modal-box rounded-lg border border-error/20 bg-base-100">
            <h3 class="flex items-center gap-2 text-lg font-semibold text-error">
              <Icon icon="lucide:triangle-alert" width="20" height="20" />
              Cancel render?
            </h3>
            <p class="py-4 text-sm text-base-content/70">
              The current FFmpeg process will stop and unfinished output for the
              active job may be incomplete.
            </p>
            <div class="modal-action mt-0">
              <form method="dialog">
                <button class="btn btn-ghost">Keep rendering</button>
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
