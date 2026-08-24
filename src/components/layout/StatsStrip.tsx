import { createMemo } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
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

  // Show a compact idle banner instead of 5 empty columns
  if (total() === 0 && !live()) {
    return (
      <div class="stats stats-vertical shadow sm:stats-horizontal w-full bg-base-100 opacity-70">
        <div class="stat">
          <div class="stat-figure text-primary/50">
            <Icon icon="lucide:sparkles" width="28" height="28" />
          </div>
          <div class="stat-title">Ready</div>
          <div class="stat-value text-base-content/40 text-lg">Idle</div>
          <div class="stat-desc text-base-content/40">
            Configure your sources and start a render
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="stats stats-vertical shadow sm:stats-horizontal w-full bg-base-100">
      <div class="stat">
        <div class="stat-figure text-primary">
          <Icon icon="lucide:list-checks" width="28" height="28" />
        </div>
        <div class="stat-title">Total Jobs</div>
        <div class="stat-value">{total()}</div>
        <div class="stat-desc">
          {counts().processing} processing · {counts().pending} queued
        </div>
      </div>

      <div class="stat">
        <div class="stat-figure text-success">
          <Icon icon="lucide:circle-check" width="28" height="28" />
        </div>
        <div class="stat-title">Done</div>
        <div class="stat-value text-success">{counts().done}</div>
        <div class="stat-desc">jobs done</div>
      </div>

      <div class="stat">
        <div class="stat-figure text-error">
          <Icon icon="lucide:circle-x" width="28" height="28" />
        </div>
        <div class="stat-title">Failed</div>
        <div class="stat-value text-error">{counts().failed}</div>
        <div class="stat-desc">needs attention</div>
      </div>

      <div class="stat" aria-live="polite">
        <div class="stat-figure text-primary">
          <Icon icon="lucide:gauge" width="28" height="28" />
        </div>
        <div class="stat-title">Progress</div>
        <div class="stat-value text-primary">{pct()}%</div>
        <div class="stat-desc">{eta()}</div>
      </div>

      <div class="stat" aria-live="polite">
        <div class="stat-figure text-secondary">
          <Icon icon="lucide:activity" width="28" height="28" />
        </div>
        <div class="stat-title">Live Render</div>
        <div class="stat-value text-secondary text-lg">
          {(() => {
            const l = live();
            return l ? `${l.speed.toFixed(1)}x` : 'Idle';
          })()}
        </div>
        <div class="stat-desc">
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
          <div class="stat" aria-live="polite">
            <div class="stat-figure text-info">
              <Icon icon="lucide:film" width="28" height="28" />
            </div>
            <div class="stat-title">Now Encoding</div>
            <div class="stat-value truncate text-info text-lg" title={name}>
              {name}
            </div>
            <div class="stat-desc">current video</div>
          </div>
        );
      })()}
    </div>
  );
}
