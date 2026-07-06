import { Icon } from '@iconify-icon/solid';

export function FatalScreen(props: { error: any; reset: () => void }) {
  return (
    <div class="flex h-screen items-center justify-center bg-base-200 p-8">
      <div class="rounded-lg border border-base-300 bg-base-100 shadow-sm max-w-lg w-full p-8 text-center">
        <Icon
          icon="lucide:triangle-alert"
          class="mx-auto mb-4 text-error"
          width="48"
          height="48"
        />
        <h2 class="mb-2 text-xl font-semibold">Something went wrong</h2>
        <p class="mb-4 text-sm text-base-content/60">
          {props.error?.message || 'An unexpected error occurred.'}
        </p>
        <button class="btn btn-primary" onClick={props.reset}>
          Reload app
        </button>
      </div>
    </div>
  );
}
