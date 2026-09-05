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
import { Icon } from '../ui/Icon';
import { ProgressBarStatus } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { createLogger } from '../../core/logger';
import { getSourcePaths } from '../../core/config';

const log = createLogger('Dashboard');
import { getSafeWindow } from '../../core/window';
import { usePipeline } from '../../hooks/usePipeline';
import { SettingsCard } from './SettingsCard';
import { Sidebar } from './Sidebar';
import { StatsStrip } from './StatsStrip';
import { Titlebar } from './Titlebar';
import { PipelineProvider, type Pipeline } from '../../context/pipeline';
import { type AppTabId } from '../../hooks/useAppShortcuts';
import { ActivityView, InspectorRail } from './DashboardPanels';

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

export function Dashboard(props: {
  pipeline: Pipeline;
  activeTab: Accessor<AppTabId>;
  setActiveTab: Setter<AppTabId>;
}) {
  const { pipeline, activeTab, setActiveTab } = props;
  const appWindow = getSafeWindow();

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = event.metaKey || event.ctrlKey;
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
      if (mod && event.key === 'p' && !event.shiftKey) {
        event.preventDefault();
        if (pipeline.running()) pipeline.pauseRender();
        else if (pipeline.paused()) pipeline.resumeRender();
      }
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
    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      if (!pipeline.running() && !pipeline.paused()) return;
      event.preventDefault();
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
        if (pipeline.running()) await pipeline.pauseRender();
        appWindow.close();
      }
    });
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown);
      unlistenClose
        .then((fn) => fn())
        .catch((err) => log.warn('unlisten close failed:', err));
    });
  });

  const renderEstimate = createMemo(() => {
    if (pipeline.running() || pipeline.paused()) return undefined;
    const videoCount = getSourcePaths(pipeline.videoSource()).length;
    const audioCount = getSourcePaths(pipeline.audioSource()).length;
    if (videoCount === 0 || audioCount === 0) return undefined;
    const songsPerVideo = pipeline.songsPerPlaylist();
    const totalSongs = videoCount * songsPerVideo;
    const loopDesc =
      pipeline.loopMode() === 'duration'
        ? ` · min ${pipeline.minDurationHours()}h`
        : ` · ${pipeline.loopCount()}x loop`;
    return `${videoCount} video${videoCount > 1 ? 's' : ''} · ~${songsPerVideo} song${songsPerVideo > 1 ? 's' : ''} each · ${totalSongs} total${loopDesc}`;
  });

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
      key = 'complete';
      call = () => appWindow.setProgressBar({ progress: 100 });
    } else {
      key = 'none';
      call = () => appWindow.setProgressBar({ status: ProgressBarStatus.None });
    }
    if (key === lastSentTaskbar) return;
    lastSentTaskbar = key;
    call().catch((err) => log.warn('setProgressBar failed:', err));
  });

  return (
    <div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
      <Titlebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        running={pipeline.running()}
        paused={pipeline.paused()}
        jobCount={pipeline.jobs().length}
      />
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
      <div class="flex min-h-0 flex-1">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          jobCount={pipeline.jobs().length}
        />
        <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden xl:flex-row">
          <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Show when={activeTab() === 'renderer'}>
              <div class="overflow-y-auto flex-1 custom-scrollbar">
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
            <Show when={activeTab() === 'activity'}>
              <ActivityView pipeline={pipeline} setActiveTab={setActiveTab} />
            </Show>
          </section>
          <InspectorRail
            pipeline={pipeline}
            renderEstimate={renderEstimate}
            activeTab={activeTab}
          />
        </main>
      </div>
    </div>
  );
}
