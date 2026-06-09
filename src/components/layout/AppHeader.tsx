import { Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';

export function AppHeader(props: {
  running: boolean;
  onStart: (resume: boolean) => void;
  onCancel: () => void;
  onPause: () => void;
  canStart: boolean;
}) {
  let cancelModalRef!: HTMLDialogElement;

  const confirmCancel = () => {
    props.onCancel();
    cancelModalRef.close();
  };

  return (
    <>
      <section class="panel p-4">
        <div class="flex items-start gap-3">
          <div
            class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${props.running ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary'}`}
          >
            <Icon
              icon={props.running ? 'lucide:loader-2' : 'lucide:play'}
              class={props.running ? 'animate-spin' : ''}
              width="20"
              height="20"
            />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="font-semibold">
              {props.running ? 'Rendering batch' : 'Ready'}
            </h3>
            <p class="mt-1 text-sm text-base-content/60">
              {props.running
                ? 'Batch in progress.'
                : props.canStart
                  ? 'All paths set.'
                  : 'Missing paths.'}
            </p>
          </div>
        </div>

        <div class="mt-4 flex flex-col gap-2">
          <button
            type="button"
            class="btn btn-primary w-full gap-2"
            disabled={props.running || !props.canStart}
            onClick={() => props.onStart(false)}
          >
            <Show
              when={props.running}
              fallback={
                <>
                  <Icon icon="lucide:play" width="18" height="18" />
                  Start new batch
                </>
              }
            >
              <span class="loading loading-spinner loading-sm" />
              Processing
            </Show>
          </button>

          <Show when={!props.running && props.canStart}>
            <button
              type="button"
              class="btn btn-secondary w-full gap-2"
              onClick={() => props.onStart(true)}
            >
              <Icon icon="lucide:play-circle" width="18" height="18" />
              Resume batch
            </button>
          </Show>

          <Show when={props.running}>
            <button
              type="button"
              class="btn btn-warning w-full gap-2"
              onClick={props.onPause}
            >
              <Icon icon="lucide:pause" width="18" height="18" />
              Pause render
            </button>

            <button
              type="button"
              class="btn btn-outline btn-error w-full gap-2"
              onClick={() => cancelModalRef.showModal()}
            >
              <Icon icon="lucide:circle-stop" width="18" height="18" />
              Cancel render
            </button>
          </Show>
        </div>
      </section>

      <dialog ref={cancelModalRef} class="modal modal-bottom sm:modal-middle">
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
    </>
  );
}
