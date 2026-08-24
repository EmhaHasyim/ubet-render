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
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getSourcePaths } from '../../core/config';
import { usePipeline } from '../../hooks/usePipeline';
import {
  AppHeader,
  HardwareInfo,
  JobTable,
  LogViewer,
  OverallProgress,
  SettingsCard,
  StatsStrip,
  Titlebar,
} from '../index';
import { PipelineProvider, type Pipeline } from '../../context/pipeline';
import { type AppTabId } from '../../hooks/useAppShortcuts';
import logoUrl from '../../assets/logo.svg';

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
  const appWindow = getCurrentWindow();

  const tabClass = (tab: AppTabId) =>
    `tab gap-2 ${activeTab() === tab ? 'tab-active' : ''}`;

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
  createEffect(() => {
    const pct = pipeline.overallProgress();

    if (pipeline.running()) {
      appWindow
        .setProgressBar({ progress: Math.round(Math.min(100, pct || 0)) })
        .catch(() => {});
    } else if (pipeline.hasFailed()) {
      appWindow
        .setProgressBar({
          status: ProgressBarStatus.Error,
          progress: Math.round(Math.min(100, pct || 0)),
        })
        .catch(() => {});
    } else if (pct > 0) {
      // Render complete, briefly show full bar then clear
      appWindow.setProgressBar({ progress: 100 }).catch(() => {});
    } else {
      appWindow
        .setProgressBar({ status: ProgressBarStatus.None })
        .catch(() => {});
    }
  });

  return (
    <div class="h-screen overflow-hidden bg-base-200 text-base-content">
      {/* ---- Custom titlebar (window controls + drag region) ---- */}
      <Titlebar />

      {/* ---- Header (DaisyUI navbar) ---- */}
      <header class="navbar border-b border-base-300 bg-base-100 px-5">
        <div class="navbar-start flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-base-200 p-1">
            <img src={logoUrl} class="h-full w-full" alt="Ubet Render" />
          </div>
          <div class="min-w-0">
            <h1 class="truncate text-base font-semibold leading-5">
              Ubet Render
            </h1>
            <p class="truncate text-xs text-base-content/60">Local workspace</p>
          </div>
        </div>

        <div class="navbar-center flex">
          <div
            class="tabs tabs-box"
            role="tablist"
            aria-label="Main navigation"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                setActiveTab((prev) =>
                  prev === 'renderer' ? 'activity' : 'renderer',
                );
                requestAnimationFrame(() => {
                  const el = document.querySelector(
                    'button[role="tab"][aria-selected="true"]',
                  ) as HTMLElement | null;
                  el?.focus();
                });
              }
            }}
          >
            <button
              role="tab"
              aria-selected={activeTab() === 'renderer'}
              tabIndex={activeTab() === 'renderer' ? 0 : -1}
              class={tabClass('renderer')}
              onClick={() => setActiveTab('renderer')}
            >
              <Icon icon="lucide:wand-sparkles" width="16" height="16" />
              Render
            </button>
            <button
              role="tab"
              aria-selected={activeTab() === 'activity'}
              tabIndex={activeTab() === 'activity' ? 0 : -1}
              class={tabClass('activity')}
              onClick={() => setActiveTab('activity')}
            >
              <Icon icon="lucide:list-checks" width="16" height="16" />
              Activity
              <Show when={pipeline.jobs().length > 0}>
                <span class="badge badge-sm ml-1">
                  {pipeline.jobs().length}
                </span>
              </Show>
            </button>
          </div>
        </div>

        <div class="navbar-end flex items-center gap-2" aria-live="polite">
          <Show when={pipeline.paused()}>
            <span class="badge badge-info badge-sm gap-1">
              <Icon icon="lucide:pause" width="12" height="12" />
              Paused
            </span>
          </Show>
          <Show
            when={pipeline.running()}
            fallback={
              <Show when={!pipeline.paused()}>
                <span class="badge badge-outline badge-sm">Idle</span>
              </Show>
            }
          >
            <span class="badge badge-info badge-sm gap-1">
              <span class="loading loading-spinner loading-xs" />
              Rendering
            </span>
          </Show>
        </div>
      </header>

      {/* ---- Slim progress bar (YouTube-style) ---- */}
      <Show
        when={
          pipeline.running() ||
          pipeline.paused() ||
          pipeline.overallProgress() > 0
        }
      >
        <div
          class="h-1 bg-base-200"
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

      {/* ---- Main content area ---- */}
      <main class="flex flex-col overflow-hidden h-[calc(100vh-6.75rem)]">
        {/* ---- Render tab: full-page scroll ---- */}
        <Show when={activeTab() === 'renderer'}>
          <div class="overflow-y-auto flex-1 custom-scrollbar">
            <div class="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
              <div class="tab-content flex flex-col">
                <div class="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <div class="flex min-w-0 flex-col gap-5">
                    <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h2 class="text-2xl font-semibold">Render setup</h2>
                        <p class="text-sm text-base-content/60">
                          Sources, audio, output, and encoding.
                        </p>
                      </div>
                      <button
                        class="btn btn-ghost btn-sm gap-2"
                        onClick={() => setActiveTab('activity')}
                      >
                        <Icon icon="lucide:logs" width="16" height="16" />
                        View activity
                      </button>
                    </div>

                    <StatsStrip />

                    <SettingsCard />

                    {/* Mini log viewer — shows while render is running so
                        the user doesn't need to switch tabs to see progress */}
                    <Show
                      when={
                        pipeline.running() ||
                        pipeline.paused() ||
                        (pipeline.overallProgress() > 0 &&
                          pipeline.overallProgress() < 100)
                      }
                    >
                      <MiniLogViewer logs={pipeline.logs()} />
                    </Show>
                  </div>

                  <aside class="flex min-w-0 flex-col gap-5">
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

                    <HardwareInfo info={pipeline.hardwareInfo()} />

                    <OverallProgress
                      value={pipeline.overallProgress()}
                      eta={pipeline.overallEta()}
                      active={
                        pipeline.running() ||
                        pipeline.paused() ||
                        pipeline.overallProgress() > 0
                      }
                    />
                  </aside>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* ---- Activity tab: fixed-height, panels scroll independently ---- */}
        <Show when={activeTab() === 'activity'}>
          <div class="flex flex-1 flex-col overflow-hidden p-4 md:p-6">
            <div class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 overflow-hidden">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between shrink-0">
                <div>
                  <h2 class="text-2xl font-semibold">Activity</h2>
                  <p class="text-sm text-base-content/60">Jobs and logs.</p>
                </div>
                <button
                  class="btn btn-primary btn-sm gap-2"
                  onClick={() => setActiveTab('renderer')}
                >
                  <Icon icon="lucide:arrow-left" width="16" height="16" />
                  Back to setup
                </button>
              </div>

              <div class="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px] overflow-hidden">
                {/* ---- Jobs panel ---- */}
                <section class="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
                  <div class="flex items-center justify-between border-b border-base-300 px-4 py-3 shrink-0">
                    <div class="flex items-center gap-2">
                      <Icon
                        icon="lucide:layers-3"
                        class="text-primary"
                        width="18"
                        height="18"
                      />
                      <h3 class="font-semibold">Jobs</h3>
                    </div>
                    <span class="badge badge-ghost badge-sm">
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
      </main>
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
      <div class="flex items-center gap-2 border-b border-base-300 px-3 py-2 shrink-0">
        <Icon
          icon="lucide:terminal"
          class="text-primary"
          width="14"
          height="14"
        />
        <span class="text-xs font-semibold">Recent logs</span>
        <span class="badge badge-ghost badge-xs ml-auto font-mono">
          {props.logs.length}
        </span>
      </div>
      <div
        ref={scrollRef}
        class="max-h-40 overflow-y-auto bg-neutral p-2 font-mono text-xs leading-relaxed text-neutral-content custom-scrollbar"
      >
        {visible().length === 0 ? (
          <p class="py-2 text-center text-neutral-content/50 text-[0.65rem]">
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
