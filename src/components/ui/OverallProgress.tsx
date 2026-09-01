import { Show } from 'solid-js';
import { Skeleton } from './Skeleton';

/**
 * When `active` is false, render a placeholder panel so the layout never
 * shifts when the render starts — avoids the HardwareInfo card jumping down.
 *
 * When `active` is true, show the real progress bar with ETA. A skeleton
 * placeholder covers the brief window between activation and the first
 * progress data arriving (value === 0, no eta).
 */
export function OverallProgress(props: {
  value: number;
  eta?: string;
  active: boolean;
}) {
  const safeValue = () =>
    Math.min(100, Math.max(0, Number.isFinite(props.value) ? props.value : 0));

  return (
    <Show
      when={props.active}
      fallback={
        <section class="panel" aria-label="Batch progress — idle">
          <div class="card-body p-4">
            <div class="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold">Batch progress</h3>
                <p class="mt-0.5 text-[13px] text-base-content/50">
                  Waiting for render start
                </p>
              </div>
              <span class="font-mono text-xl font-semibold text-base-content/20">
                —
              </span>
            </div>
            <progress
              class="progress progress-primary w-full h-2.5"
              value={0}
              max="100"
              aria-label="Batch progress (idle)"
            />
          </div>
        </section>
      }
    >
      {/* Skeleton while waiting for first progress update */}
      <Show
        when={!(props.value === 0 && !props.eta)}
        fallback={
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
        }
      >
        <section class="panel" aria-live="polite">
          <div class="card-body p-4">
            <div class="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold">Batch progress</h3>
                <p class="mt-0.5 text-[13px] text-base-content/50">
                  {props.eta || 'Preparing...'}
                </p>
              </div>
              <span class="font-mono text-xl font-semibold">
                {Math.round(safeValue())}%
              </span>
            </div>
            <progress
              class="progress progress-primary w-full h-2.5"
              value={Math.round(safeValue())}
              max="100"
              aria-label="Batch progress"
            />
          </div>
        </section>
      </Show>
    </Show>
  );
}
