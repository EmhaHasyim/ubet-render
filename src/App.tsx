// src/App.tsx
import { createSignal, Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { usePipeline } from './hooks/usePipeline';
import {
  AppHeader,
  HardwareInfo,
  JobTable,
  LogViewer,
  OverallProgress,
  SettingsCard,
} from './components';

type TabId = 'renderer' | 'activity';

export default function App() {
  const pipeline = usePipeline();
  const [activeTab, setActiveTab] = createSignal<TabId>('renderer');

  const tabClass = (tab: TabId) =>
    `btn btn-sm h-10 px-4 rounded-lg gap-2 ${
      activeTab() === tab ? 'btn-primary' : 'btn-ghost text-base-content/70'
    }`;

  return (
    <div class="h-screen overflow-hidden bg-base-200 text-base-content">
      <header class="h-16 border-b border-base-300 bg-base-100">
        <div class="mx-auto flex h-full max-w-7xl items-center justify-between px-5">
          <div class="flex min-w-0 items-center gap-3">
            <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-content">
              <Icon icon="lucide:clapperboard" width="20" height="20" />
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold leading-5">Ubet Render</h1>
              <p class="truncate text-xs text-base-content/55">Local workspace</p>
            </div>
          </div>

          <nav class="join hidden rounded-lg bg-base-200 p-1 sm:flex">
            <button class={`join-item ${tabClass('renderer')}`} onClick={() => setActiveTab('renderer')}>
              <Icon icon="lucide:wand-sparkles" width="16" height="16" />
              Render
            </button>
            <button class={`join-item ${tabClass('activity')}`} onClick={() => setActiveTab('activity')}>
              <Icon icon="lucide:list-checks" width="16" height="16" />
              Activity
              <Show when={pipeline.jobs().length > 0}>
                <span class="badge badge-sm">{pipeline.jobs().length}</span>
              </Show>
            </button>
          </nav>

          <div class="flex items-center gap-2">
            <Show
              when={pipeline.running()}
              fallback={<span class="badge badge-outline badge-sm">Idle</span>}
            >
              <span class="badge badge-warning badge-sm gap-1">
                <span class="loading loading-spinner loading-xs" />
                Rendering
              </span>
            </Show>
          </div>
        </div>
      </header>

      <div class="flex border-b border-base-300 bg-base-100 px-3 py-2 sm:hidden">
        <div class="join w-full rounded-lg bg-base-200 p-1">
          <button class={`join-item flex-1 ${tabClass('renderer')}`} onClick={() => setActiveTab('renderer')}>
            <Icon icon="lucide:wand-sparkles" width="16" height="16" />
            Render
          </button>
          <button class={`join-item flex-1 ${tabClass('activity')}`} onClick={() => setActiveTab('activity')}>
            <Icon icon="lucide:list-checks" width="16" height="16" />
            Activity
          </button>
        </div>
      </div>

      <main class="h-[calc(100vh-7.5rem)] overflow-y-auto custom-scrollbar sm:h-[calc(100vh-4rem)]">
        <div class="mx-auto flex max-w-7xl flex-col gap-5 p-4 md:p-6">
          <Show when={activeTab() === 'renderer'}>
            <div class="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div class="flex min-w-0 flex-col gap-5">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h2 class="text-2xl font-semibold">Render setup</h2>
                    <p class="text-sm text-base-content/60">Sources, audio, output, and encoding.</p>
                  </div>
                  <button class="btn btn-ghost btn-sm gap-2" onClick={() => setActiveTab('activity')}>
                    <Icon icon="lucide:logs" width="16" height="16" />
                    View activity
                  </button>
                </div>

                <SettingsCard
                  videoSource={pipeline.videoSource()}
                  audioSource={pipeline.audioSource()}
                  outputPath={pipeline.outputPath()}
                  songsPerPlaylist={pipeline.songsPerPlaylist()}
                  minDurationHours={pipeline.minDurationHours()}
                  codec={pipeline.codec()}
                  av1Supported={pipeline.av1Supported()}
                  outputPrefix={pipeline.outputPrefix()}
                  maxrate={pipeline.maxrate()}
                  usePingpong={pipeline.usePingpong()}
                  onVideoChange={pipeline.setVideoSource}
                  onAudioChange={pipeline.setAudioSource}
                  onOutputChange={pipeline.setOutputPath}
                  onSongsPerPlaylistChange={pipeline.setSongsPerPlaylist}
                  onMinDurationHoursChange={pipeline.setMinDurationHours}
                  onCodecChange={pipeline.setCodec}
                  onOutputPrefixChange={pipeline.setOutputPrefix}
                  onMaxrateChange={pipeline.setMaxrate}
                  onUsePingpongChange={pipeline.setUsePingpong}
                  dragHover={pipeline.dragHover()}
                />
              </div>

              <aside class="flex min-w-0 flex-col gap-5">
                <AppHeader
                  running={pipeline.running()}
                  onStart={pipeline.startRender}
                  onCancel={pipeline.cancelRender}
                  canStart={pipeline.canStart()}
                />

                <HardwareInfo info={pipeline.hardwareInfo()} />

                <Show when={pipeline.running() || pipeline.overallProgress() > 0}>
                  <OverallProgress value={pipeline.overallProgress()} eta={pipeline.overallEta()} />
                </Show>
              </aside>
            </div>
          </Show>

          <Show when={activeTab() === 'activity'}>
            <div class="flex min-h-[calc(100vh-8rem)] flex-col gap-5">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 class="text-2xl font-semibold">Activity</h2>
                  <p class="text-sm text-base-content/60">Jobs and logs.</p>
                </div>
                <button class="btn btn-primary btn-sm gap-2" onClick={() => setActiveTab('renderer')}>
                  <Icon icon="lucide:arrow-left" width="16" height="16" />
                  Back to setup
                </button>
              </div>

              <div class="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
                <section class="panel flex min-h-[360px] min-w-0 flex-col overflow-hidden">
                  <div class="flex items-center justify-between border-b border-base-300 px-4 py-3">
                    <div class="flex items-center gap-2">
                      <Icon icon="lucide:layers-3" class="text-primary" width="18" height="18" />
                      <h3 class="font-semibold">Jobs</h3>
                    </div>
                    <span class="badge badge-ghost badge-sm">{pipeline.jobs().length} total</span>
                  </div>
                  <div class="min-h-0 flex-1 overflow-auto p-3 custom-scrollbar">
                    <JobTable jobs={pipeline.jobs()} />
                  </div>
                </section>

                <LogViewer logs={pipeline.logs()} />
              </div>
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
}
