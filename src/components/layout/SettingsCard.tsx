// src/components/layout/SettingsCard.tsx
import { Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { open } from '@tauri-apps/plugin-dialog';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../core/config';
import type { MediaSource } from '../../core/types';
import { SourceSelector } from '../media/SourceSelector';

interface SettingsCardProps {
  videoSource: MediaSource | null;
  audioSource: MediaSource | null;
  outputPath: string;
  songsPerPlaylist: number;
  minDurationHours: number;
  codec: string;
  av1Supported: boolean;
  outputPrefix: string;
  maxrate: string;
  usePingpong: boolean;
  youtubeTimestamps: boolean;
  onVideoChange: (src: MediaSource | null) => void;
  onAudioChange: (src: MediaSource | null) => void;
  onOutputChange: (path: string) => void;
  onSongsPerPlaylistChange: (val: number) => void;
  onMinDurationHoursChange: (val: number) => void;
  onCodecChange: (codec: string) => void;
  onOutputPrefixChange: (prefix: string) => void;
  onMaxrateChange: (val: string) => void;
  onUsePingpongChange: (val: boolean) => void;
  onYoutubeTimestampsChange: (val: boolean) => void;
  dragHover?: 'video' | 'audio' | 'output' | null;
}

export function SettingsCard(props: SettingsCardProps) {
  const dropState = (target: 'video' | 'audio' | 'output') =>
    props.dragHover === target ? 'ring-2 ring-primary ring-offset-2 ring-offset-base-200' : '';

  const chooseOutput = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: props.outputPath || undefined,
    });
    if (selected) props.onOutputChange(selected as string);
  };

  return (
    <section class="panel overflow-hidden">
      <div class="border-b border-base-300 px-4 py-4 sm:px-5">
        <div class="flex flex-col gap-1">
          <h3 class="text-base font-semibold">Sources and output</h3>
          <p class="text-sm text-base-content/60">Video, audio, and destination.</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-3">
        <div id="video-dropzone" class={`rounded-lg ${dropState('video')}`}>
          <SourceSelector
            label="Master video"
            allowedExtensions={VIDEO_EXTENSIONS}
            value={props.videoSource?.paths || []}
            onChange={(paths) => props.onVideoChange(paths ? { type: 'files', paths } : null)}
            icon="lucide:video"
            themeColor="primary"
          />
        </div>

        <div id="audio-dropzone" class={`rounded-lg ${dropState('audio')}`}>
          <SourceSelector
            label="Audio tracks"
            allowedExtensions={AUDIO_EXTENSIONS}
            value={props.audioSource?.paths || []}
            onChange={(paths) => props.onAudioChange(paths ? { type: 'files', paths } : null)}
            icon="lucide:music-2"
            themeColor="secondary"
          />
        </div>

        <div id="output-dropzone" class={`flex min-h-full flex-col gap-3 rounded-lg ${dropState('output')}`}>
          <button
            type="button"
            class="flex min-h-36 w-full flex-col items-start justify-between rounded-lg border border-dashed border-accent/35 bg-accent/5 p-4 text-left text-accent transition-colors hover:border-accent"
            onClick={chooseOutput}
          >
            <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-base-100 text-current shadow-sm">
              <Icon icon="lucide:folder-output" width="20" height="20" />
            </span>

            <span class="mt-4 block">
              <span class="block text-sm font-semibold text-base-content">Output folder</span>
              <span class="mt-1 block text-xs text-base-content/60">
                {props.outputPath ? 'Destination selected' : 'Choose folder'}
              </span>
            </span>
          </button>

          <Show
            when={props.outputPath}
            fallback={
              <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-xs text-base-content/55">
                No folder selected.
              </div>
            }
          >
            <div class="rounded-lg border border-base-300 bg-base-100 p-3">
              <p class="mb-1 text-xs font-medium text-base-content/70">Selected folder</p>
              <p class="truncate text-xs text-base-content/80" title={props.outputPath}>
                {props.outputPath}
              </p>
            </div>
          </Show>
        </div>
      </div>

      <div class="border-t border-base-300 bg-base-100/60 p-4 sm:p-5">
        <div class="mb-4 flex items-center gap-2">
          <Icon icon="lucide:sliders-horizontal" class="text-primary" width="18" height="18" />
          <h3 class="text-base font-semibold">Render options</h3>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label class="form-control">
            <span class="label py-1">
              <span class="label-text font-medium">Songs per video</span>
            </span>
            <input
              type="number"
              class="input input-bordered w-full bg-base-100"
              min="1"
              max="50"
              value={props.songsPerPlaylist}
              onInput={(e) => props.onSongsPerPlaylistChange(Math.max(1, parseInt(e.currentTarget.value) || 1))}
            />
          </label>

          <label class="form-control">
            <span class="label py-1">
              <span class="label-text font-medium">Minimum duration</span>
            </span>
            <label class="input input-bordered flex items-center gap-2 bg-base-100">
              <input
                type="number"
                class="grow"
                min="0.1"
                step="0.1"
                value={props.minDurationHours}
                onInput={(e) => props.onMinDurationHoursChange(Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1))}
              />
              <span class="text-sm text-base-content/55">hours</span>
            </label>
          </label>

          <label class="form-control">
            <span class="label py-1">
              <span class="label-text font-medium">Video codec</span>
            </span>
            <select
              class="select select-bordered w-full bg-base-100"
              value={props.codec}
              onChange={(e) => props.onCodecChange(e.currentTarget.value)}
            >
              <option value="h264">H.264</option>
              <option value="h265">H.265</option>
              <option value="av1" disabled={!props.av1Supported}>
                AV1 {!props.av1Supported ? '(unsupported)' : ''}
              </option>
            </select>
          </label>

          <label class="form-control">
            <span class="label py-1">
              <span class="label-text font-medium">Max bitrate</span>
            </span>
            <input
              type="text"
              class="input input-bordered w-full bg-base-100"
              placeholder="4000k"
              value={props.maxrate}
              onInput={(e) => props.onMaxrateChange(e.currentTarget.value)}
            />
          </label>

          <label class="form-control">
            <span class="label py-1">
              <span class="label-text font-medium">Output prefix</span>
            </span>
            <input
              type="text"
              class="input input-bordered w-full bg-base-100"
              placeholder="Ubet Render"
              value={props.outputPrefix}
              onInput={(e) => props.onOutputPrefixChange(e.currentTarget.value)}
            />
          </label>

          <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
            <span>
              <span class="block text-sm font-medium">Ping-pong effect</span>
              <span class="block text-xs text-base-content/55">Mirrored loop</span>
            </span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={props.usePingpong}
              onChange={(e) => props.onUsePingpongChange(e.currentTarget.checked)}
            />
          </label>

          <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
            <span>
              <span class="block text-sm font-medium">YouTube Timestamps</span>
              <span class="block text-xs text-base-content/55">Looping disatukan</span>
            </span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={props.youtubeTimestamps}
              onChange={(e) => props.onYoutubeTimestampsChange(e.currentTarget.checked)}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
