import {
  createEffect,
  createMemo,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
  type Setter,
} from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { ProgressBarStatus } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getSourcePaths } from '../../core/config';
import { getSafeWindow } from '../../core/window';
import { usePipeline } from '../../hooks/usePipeline';
import {
  AppHeader,
  HardwareInfo,
  JobTable,
  LogViewer,
  OverallProgress,
  SettingsCard,
  Sidebar,
  StatsStrip,
  Titlebar,
} from '../index';
import { PipelineProvider, type Pipeline } from '../../context/pipeline';
import { type AppTabId } from '../../hooks/useAppShortcuts';

/**
 * Thin bridge that calls {@link usePipeline} *inside* the ErrorBoundary tree.
 *
 * Previously `usePipeline` was called at the top of `App` and wrapped in a
 * try/catch that fell back to a dead placeholder — once initialisation failed
 * the user was stuck with a non-functional UI until a manual page reload.
 *
 * Now, if `usePipeline` throws (corrupt localStorage, missing Tauri IPC, etc.),
 * the ErrorBoundary catches it and `<FatalScreen>` presents a "Try Again" button
 * that remounts this component, retrying initialisation without losing the
 * application shell.
 */
export function PipelineBridge(props: {
  children: (pipeline: Pipeline) => JSX.Element;
}) {
  const pipeline = usePipeline();
  return (
    <PipelineProvider value={pipeline}>
      {props.children(pipeline)}
    </PipelineProvider>
  );
}

/**
 * The main dashboard UI, extracted from `App` so it receives `pipeline` as a
 * prop instead of referencing it from an outer scope.  This lets
 * {@link PipelineBridge} own the `usePipeline` call site.
 */
export function Dashboard(props: {
  pipeline: Pipeline;
  activeTab: Accessor<AppTabId>;
  setActiveTab: Setter<AppTabId>;
}) {
  const { pipeline, activeTab, setActiveTab } = props;
  const appWindow = getSafeWindow();

  // ── Render keyboard shortcuts + close guard ──────────────
  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't intercept shortcuts when the user is typing in an input field.
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const mod = event.metaKey || event.ctrlKey;

      // Ctrl+Enter → Start
      if (
        mod &&
        event.key === 'Enter' &&
        !pipeline.running() &&
        !pipeline.paused() &&
        pipeline.canStart()
      ) {
        event.preventDefault();
        pipeline.startRender(false);
      }

      // Ctrl+P → Pause / Resume
      if (mod && event.key === 'p' && !event.shiftKey) {
        event.preventDefault();
        if (pipeline.running()) pipeline.pauseRender();
        else if (pipeline.paused()) pipeline.resumeRender();
      }

      // Ctrl+Shift+C → Cancel (when running or paused)
      if (
        mod &&
        event.shiftKey &&
        event.key === 'C' &&
        (pipeline.running() || pipeline.paused())
      ) {
        event.preventDefault();
        pipeline.cancelRender();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Intercept window close while rendering — save state first so the user
    // can resume later.  A native dialog confirms the action.
    const unlistenClose = appWindow.onCloseRequested(async (ev) => {
      if (!pipeline.running() && !pipeline.paused()) return;
      // Prevent immediate close; the dialog is async.
      ev.preventDefault();
      const isPaused = !pipeline.running() && pipeline.paused();
      const ok = await confirm(
        isPaused
          ? 'A render is paused. Close anyway? Progress will be saved.'
          : 'A render is in progress. Close anyway?',
        {
          title: isPaused ? 'Render paused' : 'Render in progress',
          kind: 'warning',
          okLabel: 'Close',
          cancelLabel: isPaused ? 'Keep paused' : 'Keep rendering',
        },
      );
      if (ok) {
        // Auto-pause + save before closing so the user can resume.
        if (pipeline.running()) await pipeline.pauseRender();
        appWindow.close();
      }
    });

    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown);
      unlistenClose.then((fn) => fn()).catch(() => {});
    });
  });

  // ── Pre-start render estimate ────────────────────────────
  const renderEstimate = createMemo(() => {
    if (pipeline.running() || pipeline.paused()) return undefined;
    const videoCount = getSourcePaths(pipeline.videoSource()).length;
    const audioCount = getSourcePaths(pipeline.audioSource()).length;
    if (videoCount === 0 || audioCount === 0) return undefined;

    const songsPerVideo = pipeline.songsPerPlaylist();
    const totalSongs = videoCount * songsPerVideo;
    const loopMode = pipeline.loopMode();

    let loopDesc = '';
    if (loopMode === 'duration') {
      const hrs = pipeline.minDurationHours();
      loopDesc = ` · min ${hrs}h`;
    } else {
      const cnt = pipeline.loopCount();
      loopDesc = ` · ${cnt}x loop`;
    }

    return `${videoCount} video${videoCount > 1 ? 's' : ''} · ~${songsPerVideo} song${songsPerVideo > 1 ? 's' : ''} each · ${totalSongs} total${loopDesc}`;
  });

  // ── Taskbar progress indicator (Windows) ───────────────────
  // Progress events arrive ~8×/second; only hit the IPC boundary when the
  // observable taskbar state actually changes (status or rounded percent).
  let lastSentTaskbar = '';
  createEffect(() => {
    const pct = pipeline.overallProgress();
    const rounded = Math.round(Math.min(100, pct || 0));

    let key: string;
    let call: () => Promise<unknown>;

    if (pipeline.running()) {
      key = `normal:${rounded}`;
      call = () => appWindow.setProgressBar({ progress: rounded });
    } else if (pipeline.hasFailed()) {
      key = `error:${rounded}`;
      call = () =>
        appWindow.setProgressBar({
          status: ProgressBarStatus.Error,
          progress: rounded,
        });
    } else if (pct > 0) {
      // Render complete, briefly show full bar then clear
      key = 'complete';
      call = () => appWindow.setProgressBar({ progress: 100 });
    } else {
      key = 'none';
      call = () => appWindow.setProgressBar({ status: ProgressBarStatus.None });
    }

    if (key === lastSentTaskbar) return;
    lastSentTaskbar = key;
    call().catch(() => {});
  });

  return (
    <div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
      {/* ---- Slim chrome bar: brand, page, status, window controls ---- */}
      <Titlebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        running={pipeline.running()}
        paused={pipeline.paused()}
        jobCount={pipeline.jobs().length}
      />

      {/* ---- Slim progress bar (YouTube-style) ---- */}
      <Show
        when={
          pipeline.running() ||
          pipeline.paused() ||
          pipeline.overallProgress() > 0
        }
      >
        <div
          class="h-1 shrink-0 bg-base-200"
          role="progressbar"
          aria-label="Global render progress"
        >
          <div
            class="h-full bg-primary transition-all duration-500 ease-linear"
            style={{
              width: `${Math.min(100, Math.max(0, pipeline.overallProgress() || 0))}%`,
            }}
          />
        </div>
      </Show>

      {/* ---- Navigation rail + main content ---- */}
      <div class="flex min-h-0 flex-1">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          jobCount={pipeline.jobs().length}
        />

        <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden xl:flex-row">
          <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {/* ---- Render tab: full-bleed scroll ---- */}
            <Show when={activeTab() === 'renderer'}>
              <div class="overflow-y-auto flex-1 custom-scrollbar">
                {/* ---- Sticky page header (stays pinned while steps scroll) ---- */}
                <div class="sticky top-0 z-10 border-b border-base-300/60 bg-base-200/85 backdrop-blur-sm">
                  <div class="mx-auto flex w-full max-w-[1760px] items-center justify-between gap-2 px-4 py-3 md:px-6">
                    <div class="flex items-center gap-2.5">
                      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon
                          icon="lucide:wand-sparkles"
                          width="16"
                          height="16"
                        />
                      </div>
                      <div>
                        <h2 class="text-[17px] font-semibold tracking-tight">
                          Render setup
                        </h2>
                        <p class="text-[13px] text-base-content/50">
                          Sources, audio, output, and encoding.
                        </p>
                      </div>
                    </div>
                    <button
                      class="btn btn-ghost btn-sm gap-2 border border-base-300/60"
                      onClick={() => setActiveTab('activity')}
                    >
                      <Icon icon="lucide:logs" width="15" height="15" />
                      View activity
                    </button>
                  </div>
                </div>

                <div class="mx-auto w-full max-w-[1760px] p-4 md:p-6">
                  <div class="tab-content flex flex-col gap-3.5">
                    <StatsStrip />

                    <SettingsCard />
                  </div>
                </div>
              </div>
            </Show>

            {/* ---- Activity tab: fixed-height, panels scroll independently ---- */}
            <Show when={activeTab() === 'activity'}>
              <div class="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
                <div class="mx-auto flex w-full max-w-[1760px] flex-1 flex-col gap-4 overflow-hidden">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0">
                    <div class="flex items-center gap-2.5">
                      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon
                          icon="lucide:list-checks"
                          width="16"
                          height="16"
                        />
                      </div>
                      <div>
                        <h2 class="text-[17px] font-semibold tracking-tight">
                          Activity
                        </h2>
                        <p class="text-[13px] text-base-content/50">
                          Jobs and logs.
                        </p>
                      </div>
                    </div>
                    <button
                      class="btn btn-primary btn-sm gap-2"
                      onClick={() => setActiveTab('renderer')}
                    >
                      <Icon icon="lucide:arrow-left" width="15" height="15" />
                      Back to setup
                    </button>
                  </div>

                  <div class="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_440px]">
                    {/* ---- Jobs panel ---- */}
                    <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
                      <div class="flex items-center justify-between border-b border-base-300/70 px-4 py-3 shrink-0">
                        <div class="flex items-center gap-2">
                          <Icon
                            icon="lucide:layers-3"
                            class="text-base-content/50"
                            width="16"
                            height="16"
                          />
                          <h3 class="text-sm font-semibold">Jobs</h3>
                        </div>
                        <span class="rounded-full bg-base-300/60 px-2 py-0.5 text-[11px] font-medium text-base-content/60">
                          {pipeline.jobs().length} total
                        </span>
                      </div>
                      <div class="min-h-0 flex-1 overflow-auto p-3 custom-scrollbar">
                        <JobTable
                          jobs={pipeline.jobs()}
                          onRetry={pipeline.retryJob}
                        />
                      </div>
                    </section>

                    {/* ---- Logs panel ---- */}
                    <LogViewer logs={pipeline.logs()} />
                  </div>
                </div>
              </div>
            </Show>
          </section>

          {/* ---- Inspector rail: a fixed right column on wide screens
              (16:9 fullscreen), a bottom drawer on narrow windows. Stays
              put while the setup steps scroll — Figma/DaVinci-style. ---- */}
          <aside
            class={`flex max-h-[40vh] shrink-0 flex-col gap-4 overflow-y-auto border-t border-base-300/60 bg-base-100/40 p-4 custom-scrollbar xl:max-h-none xl:w-80 xl:border-t-0 xl:border-l ${
              activeTab() === 'renderer' ? '' : 'hidden xl:flex'
            }`}
          >
            <AppHeader
              running={pipeline.running()}
              paused={pipeline.paused()}
              onStart={pipeline.startRender}
              onResume={pipeline.resumeRender}
              onCancel={pipeline.cancelRender}
              onPause={pipeline.pauseRender}
              canStart={pipeline.canStart()}
              disabledReason={pipeline.disabledReason()}
              renderEstimate={renderEstimate()}
            />

            <OverallProgress
              value={pipeline.overallProgress()}
              eta={pipeline.overallEta()}
              active={
                pipeline.running() ||
                pipeline.paused() ||
                pipeline.overallProgress() > 0
              }
            />

            <HardwareInfo info={pipeline.hardwareInfo()} />

            {/* Mini log viewer — docked at the end of the rail so live
                progress stays visible without scrolling the setup steps */}
            <MiniLogViewer logs={pipeline.logs()} />
          </aside>
        </main>
      </div>
    </div>
  );
}

/**
 * Compact log viewer for the Render tab — shows the last few log lines so
 * the user can monitor progress without switching to the Activity tab.
 * Height-constrained and auto-scrolls to the bottom on new entries.
 */
function MiniLogViewer(props: { logs: string[] }) {
  let scrollRef!: HTMLDivElement;

  // Show only the last 8 lines — enough for the most recent milestone and
  // any trailing warnings, but not so many that it dominates the layout.
  const visible = () => props.logs.slice(-8);

  // Auto-scroll to the bottom whenever logs change.
  createEffect(() => {
    props.logs;
    if (scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
      });
    }
  });

  return (
    <section class="panel flex min-h-0 flex-col overflow-hidden">
      <div class="flex items-center gap-2 border-b border-base-300/70 px-3.5 py-2 shrink-0">
        <Icon
          icon="lucide:terminal"
          class="text-base-content/50"
          width="14"
          height="14"
        />
        <span class="text-xs font-medium text-base-content/80">
          Recent logs
        </span>
        <span class="ml-auto rounded-full bg-base-300/60 px-1.5 py-0.5 font-mono text-[10px] text-base-content/60">
          {props.logs.length}
        </span>
      </div>
      <div
        ref={scrollRef}
        class="max-h-40 overflow-y-auto border-t border-base-300/40 bg-base-200/60 p-2.5 font-mono text-xs leading-relaxed text-base-content/70 custom-scrollbar"
      >
        {visible().length === 0 ? (
          <p class="py-2 text-center text-[0.65rem] text-base-content/55">
            Waiting for logs...
          </p>
        ) : (
          visible().map((line) => (
            <pre class="whitespace-pre-wrap break-words">
              <code>{line}</code>
            </pre>
          ))
        )}
      </div>
    </section>
  );
}
