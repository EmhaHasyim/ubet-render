import { Icon } from '@iconify-icon/solid';

export function FatalScreen(props: { error: unknown; reset: () => void }) {
  const message =
    props.error instanceof Error
      ? props.error.message
      : typeof props.error === 'string' && props.error
        ? props.error
        : 'An unexpected error occurred.';

  return (
    <div class="flex h-screen items-center justify-center bg-base-200 p-8">
      <div class="card w-full max-w-lg rounded-xl border border-base-300/70 bg-base-100 text-center shadow-xl shadow-black/10">
        <div class="card-body items-center px-8 py-10">
          <div class="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-error/10 text-error">
            <Icon icon="lucide:triangle-alert" width="28" height="28" />
          </div>

          <div class="mb-1 flex items-center gap-1.5">
            <div class="flex h-4 w-4 items-center justify-center rounded bg-primary/15 text-primary">
              <Icon icon="lucide:clapperboard" width="11" height="11" />
            </div>
            <span class="text-xs font-semibold uppercase tracking-wider text-base-content/55">
              Ubet Render
            </span>
          </div>

          <h2 class="mb-2 text-xl font-semibold tracking-tight">
            Something went wrong
          </h2>
          <p class="mb-6 max-w-sm text-sm leading-relaxed text-base-content/60">
            {message}
          </p>

          <div class="flex items-center gap-2">
            <button class="btn btn-primary gap-2" onClick={props.reset}>
              <Icon icon="lucide:rotate-ccw" width="16" height="16" />
              Reload app
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
