import { Skeleton } from './Skeleton';

/**
 * When `value` is exactly 0 and no `eta` is provided, render a skeleton
 * placeholder so the panel has visible content from the moment it appears,
 * avoiding a flash of an empty / zero-state bar.
 *
 * Negative and NaN values always render the real UI (clamped to 0 %) so
 * the user never loses the progress indicator during edge cases.
 */
export function OverallProgress(props: { value: number; eta?: string }) {
  const safeValue = () =>
    Math.min(100, Math.max(0, Number.isFinite(props.value) ? props.value : 0));

  // Skeleton placeholder while waiting for the first progress update
  if (props.value === 0 && !props.eta) {
    return (
      <section class="panel" aria-label="Batch progress loading">
        <div class="card-body p-4">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="flex-1 space-y-2">
              <Skeleton class="h-4 w-32" />
              <Skeleton class="h-3 w-24" />
            </div>
            <Skeleton variant="text" class="h-7 w-12" />
          </div>
          <Skeleton variant="rect" class="h-3 w-full" />
        </div>
      </section>
    );
  }

  return (
    <section class="panel" aria-live="polite">
      <div class="card-body p-4">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold">Batch progress</h3>
            <p class="text-sm text-base-content/60">
              {props.eta || 'Preparing...'}
            </p>
          </div>
          <span class="font-mono text-xl font-semibold">
            {Math.round(safeValue())}%
          </span>
        </div>
        <progress
          class="progress progress-primary w-full h-3"
          value={Math.round(safeValue())}
          max="100"
          aria-label="Batch progress"
        />
      </div>
    </section>
  );
}
