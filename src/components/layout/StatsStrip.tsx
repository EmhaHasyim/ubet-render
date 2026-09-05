import { createMemo } from 'solid-js';
import { Icon } from '../ui/Icon';
import { usePipelineContext } from '../../context/pipeline';

/**
 * KPI / summary strip shown at the top of the Render view.
 * Surfaces the 3-5 key queue metrics so the dashboard is scannable at a glance.
 * Uses DaisyUI's `stats` component (stat / stat-title / stat-value / stat-desc / stat-figure).
 */
export function StatsStrip() {
  const pipeline = usePipelineContext();
  const jobs = () => pipeline.jobs();
  const total = () => jobs().length;

  // Single-pass counter, memoized so the loop runs exactly once per
  // change to `jobs()` — not once per template access.
  const counts = createMemo(() => {
    let done = 0;
    let failed = 0;
    let processing = 0;
    let pending = 0;
    for (const j of jobs()) {
      switch (j.state) {
        case 'done':
          done++;
          break;
        case 'error':
          failed++;
          break;
        case 'processing':
          processing++;
          break;
        case 'pending':
          pending++;
          break;
      }
    }
    return { done, failed, processing, pending } as const;
  });
  const pct = () =>
    Math.round(Math.min(100, Math.max(0, pipeline.overallProgress() || 0)));
  const eta = () => pipeline.overallEta() || 'Preparing...';
  const live = () => pipeline.liveStats();

  // --- Current video name ---
  const currentVideo = createMemo(() => {
    const list = jobs();
    if (list.length === 0) return null;
    return list.find((j) => j.state === 'processing')?.name ?? null;
  });

  // Shared cell styles — compact, calm, border-separated (studio-style).
  const statClass = 'stat px-3.5 py-2.5 gap-0';
  const titleClass =
    'stat-title text-[10px] font-medium uppercase tracking-wide text-base-content/55';
  const valueClass = 'stat-value text-base font-semibold';
  const descClass = 'stat-desc text-[11px] text-base-content/55';

  // No jobs and no live stats → render nothing. The inspector rail already
  // shows the Ready state ("Ready · Missing paths" + Start button) and the
  // titlebar shows the Idle pill, so a filler banner would only waste
  // vertical space on a fullscreen desktop layout. The page starts straight
  // at pipeline step 01 instead.
  if (total() === 0 && !live()) {
    return null;
  }

  return (
    <div class="stats stats-vertical shadow-none sm:stats-horizontal w-full bg-base-100 border border-base-300/70 rounded-box overflow-hidden">
      <div class={statClass}>
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
          <Icon icon="lucide:list-checks" width="16" height="16" />
        </span>
        <div class={titleClass}>Total Jobs</div>
        <div class={valueClass}>{total()}</div>
        <div class={descClass}>
          {counts().processing} processing · {counts().pending} queued
        </div>
      </div>

      <div class={statClass}>
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
          <Icon icon="lucide:circle-check" width="16" height="16" />
        </span>
        <div class={titleClass}>Done</div>
        <div class={`${valueClass} text-success`}>{counts().done}</div>
        <div class={descClass}>jobs done</div>
      </div>

      <div class={statClass}>
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
          <Icon icon="lucide:circle-x" width="16" height="16" />
        </span>
        <div class={titleClass}>Failed</div>
        <div class={`${valueClass} text-error`}>{counts().failed}</div>
        <div class={descClass}>needs attention</div>
      </div>

      <div class={statClass} aria-live="polite">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
          <Icon icon="lucide:gauge" width="16" height="16" />
        </span>
        <div class={titleClass}>Progress</div>
        <div class={`${valueClass} text-primary`}>{pct()}%</div>
        <div class={descClass}>{eta()}</div>
      </div>

      <div class={statClass} aria-live="polite">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
          <Icon icon="lucide:activity" width="16" height="16" />
        </span>
        <div class={titleClass}>Live Render</div>
        <div class={`${valueClass} text-secondary`}>
          {(() => {
            const l = live();
            return l ? `${l.speed.toFixed(1)}x` : 'Idle';
          })()}
        </div>
        <div class={descClass}>
          {(() => {
            const l = live();
            if (!l) return 'waiting for stats';
            const b = l.bitrateKbps;
            const bStr =
              b >= 1000
                ? `${(b / 1000).toFixed(1)} Mbps`
                : `${Math.round(b)} kbps`;
            return `${l.fps.toFixed(0)} fps · ${bStr}`;
          })()}
        </div>
      </div>

      {/* Current video being encoded */}
      {(() => {
        const name = currentVideo();
        if (!name) return null;
        return (
          <div class={statClass} aria-live="polite">
            <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-base-300/50 text-base-content/70">
              <Icon icon="lucide:film" width="16" height="16" />
            </span>
            <div class={titleClass}>Now Encoding</div>
            <div class={`${valueClass} truncate text-info`} title={name}>
              {name}
            </div>
            <div class={descClass}>current video</div>
          </div>
        );
      })()}
    </div>
  );
}
