import { Show } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../core/config';
import type { MediaSource } from '../../core/types';
import { SourceSelector } from '../media/SourceSelector';
import { TAURI_COMMANDS } from '../../core/constants';
import { usePipelineContext } from '../../context/pipeline';
import { normalizeBitrate } from '../../core/estimate';
import { createLogger } from '../../core/logger';

// Replaces 1 ad-hoc console.error call; see `src/core/logger.ts`.
const log = createLogger('SettingsCard');

// Stable empty array so the binding doesn't allocate a fresh `[]` on every
// reactive re-evaluation when the source is unset.
const EMPTY_PATHS: string[] = [];

/** Extract file paths from a MediaSource regardless of variant. */
function getSourcePaths(source: MediaSource | null): string[] {
  if (source?.type === 'files') return source.paths;
  if (source?.type === 'folder') return [source.path];
  return EMPTY_PATHS;
}

const revealFile = async (path: string) => {
  try {
    await invoke(TAURI_COMMANDS.revealInExplorer, { path });
  } catch (e) {
    log.error('Failed to reveal folder:', e);
  }
};

/** Shared collapse-title classes for consistent section headers. */
const collapseTitleClass =
  'text-sm font-semibold uppercase tracking-wider text-base-content/60 flex items-center gap-2';

/** Shared collapse-content grid that mirrors the outer grid columns. */
const collapseContentGrid =
  'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 pt-1';

export function SettingsCard() {
  const pipeline = usePipelineContext();

  const dropState = (target: 'video' | 'audio' | 'output') =>
    pipeline.dragHover() === target
      ? 'ring-2 ring-primary ring-offset-2 ring-offset-base-200'
      : '';

  const chooseOutput = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: pipeline.outputPath() || undefined,
    });
    if (selected) pipeline.setOutputPath(selected as string);
  };

  return (
    <section class="panel overflow-hidden">
      {/* ---- Sources header ---- */}
      <div class="border-b border-base-300 px-4 py-4 sm:px-5">
        <div class="flex flex-col gap-1">
          <h3 class="text-base font-semibold">Sources and output</h3>
          <p class="text-sm text-base-content/60">
            Video, audio, and destination.
          </p>
        </div>
      </div>

      {/* ---- Source selectors ---- */}
      <div class="grid grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-3">
        <div id="video-dropzone" class={`rounded-lg ${dropState('video')}`}>
          <SourceSelector
            label="Master video"
            allowedExtensions={VIDEO_EXTENSIONS}
            value={getSourcePaths(pipeline.videoSource())}
            onChange={(paths) =>
              pipeline.setVideoSource(paths ? { type: 'files', paths } : null)
            }
            icon="lucide:video"
            themeColor="primary"
          />
        </div>

        <div id="audio-dropzone" class={`rounded-lg ${dropState('audio')}`}>
          <SourceSelector
            label="Audio tracks"
            allowedExtensions={AUDIO_EXTENSIONS}
            value={getSourcePaths(pipeline.audioSource())}
            onChange={(paths) =>
              pipeline.setAudioSource(paths ? { type: 'files', paths } : null)
            }
            icon="lucide:music-2"
            themeColor="secondary"
          />
        </div>

        <div
          id="output-dropzone"
          class={`flex min-h-full flex-col gap-3 rounded-lg ${dropState('output')}`}
        >
          <button
            type="button"
            class="flex min-h-36 w-full flex-col items-start justify-between rounded-lg border border-dashed border-accent/35 bg-accent/5 p-4 text-left text-accent transition-colors hover:border-accent"
            onClick={chooseOutput}
          >
            <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-base-100 text-current shadow-sm">
              <Icon icon="lucide:folder-output" width="20" height="20" />
            </span>

            <span class="mt-4 block">
              <span class="block text-sm font-semibold text-base-content">
                Output folder
              </span>
              <span class="mt-1 block text-xs text-base-content/60">
                {pipeline.outputPath()
                  ? 'Destination selected'
                  : 'Choose folder'}
              </span>
            </span>
          </button>

          <Show
            when={pipeline.outputPath()}
            fallback={
              <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-xs text-base-content/60">
                No folder selected.
              </div>
            }
          >
            <div class="rounded-lg border border-base-300 bg-base-100 p-3">
              <p class="mb-1 text-xs font-medium text-base-content/70">
                Selected folder
              </p>
              <p
                class="truncate text-xs text-base-content/80"
                title={pipeline.outputPath()}
              >
                {pipeline.outputPath()}
              </p>
              <button
                type="button"
                class="btn btn-outline btn-xs mt-2"
                onClick={() => revealFile(pipeline.outputPath()!)}
              >
                <Icon icon="lucide:folder-open" width="14" height="14" />
                Open in Explorer
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* ---- Render options ---- */}
      <div class="border-t border-base-300 bg-base-200 p-4 sm:p-5">
        <div class="mb-4 flex items-center gap-2">
          <Icon
            icon="lucide:sliders-horizontal"
            class="text-primary"
            width="18"
            height="18"
          />
          <h3 class="text-base font-semibold">Render options</h3>
        </div>

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* ════ Audio ════ */}
          <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
            <input type="checkbox" checked />
            <div class={collapseTitleClass}>
              <Icon icon="lucide:music" width="14" height="14" />
              Audio
            </div>
            <div class={collapseContentGrid}>
              <label class="form-control">
                <span class="label py-1">
                  <span class="label-text font-medium">Songs per video</span>
                </span>
                <input
                  type="number"
                  class="input input-bordered w-full bg-base-100"
                  min="1"
                  max="50"
                  value={pipeline.songsPerPlaylist()}
                  onInput={(e) =>
                    pipeline.setSongsPerPlaylist(
                      Math.max(1, parseInt(e.currentTarget.value) || 1),
                    )
                  }
                />
              </label>

              <div class="fieldset p-0">
                <span class="fieldset-legend">Audio mode</span>
                <div class="join w-full">
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="audioMode"
                    value="original"
                    checked={pipeline.audioMode() === 'original'}
                    onChange={() => pipeline.setAudioMode('original')}
                    aria-label="Original"
                  />
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="audioMode"
                    value="normalize"
                    checked={pipeline.audioMode() === 'normalize'}
                    onChange={() => pipeline.setAudioMode('normalize')}
                    aria-label="Normalize"
                  />
                </div>
                <span class="fieldset-label">
                  Original keeps audio faithful; Normalize applies YouTube Music
                  loudness.
                </span>
              </div>
            </div>
          </div>

          {/* ════ Video & Encoding ════ */}
          <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
            <input type="checkbox" checked />
            <div class={collapseTitleClass}>
              <Icon icon="lucide:monitor" width="14" height="14" />
              Video & Encoding
            </div>
            <div class={collapseContentGrid}>
              <label class="form-control">
                <span class="label py-1">
                  <span class="label-text font-medium">Video codec</span>
                </span>
                <select
                  class="select select-bordered w-full bg-base-100"
                  value={pipeline.codec()}
                  onChange={(e) => pipeline.setCodec(e.currentTarget.value)}
                >
                  <option value="h264">H.264</option>
                  <option value="h265">H.265</option>
                  <option value="av1" disabled={!pipeline.av1Supported()}>
                    AV1 {!pipeline.av1Supported() ? '(unsupported)' : ''}
                  </option>
                </select>
              </label>

              <label class="form-control">
                <span class="label py-1">
                  <span class="label-text font-medium">Max bitrate</span>
                </span>
                <input
                  type="text"
                  inputmode="numeric"
                  class={`input input-bordered w-full bg-base-100 ${!pipeline.maxrateValid() ? 'input-error' : ''}`}
                  placeholder="5000"
                  value={pipeline.maxrate()}
                  onInput={(e) => pipeline.setMaxrate(e.currentTarget.value)}
                  onBlur={(e) => {
                    const normalized = normalizeBitrate(e.currentTarget.value);
                    if (normalized !== e.currentTarget.value) {
                      pipeline.setMaxrate(normalized);
                    }
                  }}
                  aria-invalid={!pipeline.maxrateValid()}
                />
                <Show when={!pipeline.maxrateValid()}>
                  <span class="mt-1 text-xs text-error">
                    Enter a number between 100 and 50000 (e.g. 5000).
                  </span>
                </Show>
              </label>

              <div class="fieldset p-0">
                <span class="fieldset-legend">Output format</span>
                <div class="join w-full">
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="outputFormat"
                    value="mp4"
                    checked={pipeline.outputFormat() === 'mp4'}
                    onChange={() => pipeline.setOutputFormat('mp4')}
                    aria-label="MP4"
                  />
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="outputFormat"
                    value="mkv"
                    checked={pipeline.outputFormat() === 'mkv'}
                    onChange={() => pipeline.setOutputFormat('mkv')}
                    aria-label="MKV"
                  />
                </div>
                <span class="fieldset-label">
                  MP4 for widest compatibility; MKV for AV1 and best player
                  support.
                </span>
              </div>

              <label class="form-control">
                <span class="label py-1">
                  <span class="label-text font-medium">Output prefix</span>
                </span>
                <input
                  type="text"
                  class="input input-bordered w-full bg-base-100"
                  placeholder="Ubet Render"
                  value={pipeline.outputPrefix()}
                  onInput={(e) =>
                    pipeline.setOutputPrefix(e.currentTarget.value)
                  }
                />
              </label>
            </div>
          </div>

          {/* ════ Looping ════ */}
          <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
            <input type="checkbox" checked />
            <div class={collapseTitleClass}>
              <Icon icon="lucide:repeat-2" width="14" height="14" />
              Looping
            </div>
            <div class={collapseContentGrid}>
              <div class="fieldset p-0">
                <span class="fieldset-legend">Repeat mode</span>
                <div class="join w-full">
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="loopMode"
                    value="duration"
                    checked={pipeline.loopMode() === 'duration'}
                    onChange={() => pipeline.setLoopMode('duration')}
                    aria-label="By Duration"
                  />
                  <input
                    type="radio"
                    class="btn join-item btn-outline flex-1"
                    name="loopMode"
                    value="count"
                    checked={pipeline.loopMode() === 'count'}
                    onChange={() => pipeline.setLoopMode('count')}
                    aria-label="By Count"
                  />
                </div>
              </div>

              <Show when={pipeline.loopMode() === 'duration'}>
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
                      value={pipeline.minDurationHours()}
                      onInput={(e) =>
                        pipeline.setMinDurationHours(
                          Math.max(
                            0.1,
                            parseFloat(e.currentTarget.value) || 0.1,
                          ),
                        )
                      }
                    />
                    <span class="text-sm text-base-content/60">hours</span>
                  </label>
                </label>
              </Show>

              <Show when={pipeline.loopMode() === 'count'}>
                <label class="form-control">
                  <span class="label py-1">
                    <span class="label-text font-medium">Repeat count</span>
                  </span>
                  <input
                    type="number"
                    class="input input-bordered w-full bg-base-100"
                    min="1"
                    max="100"
                    value={pipeline.loopCount()}
                    onInput={(e) =>
                      pipeline.setLoopCount(
                        Math.max(
                          1,
                          Math.min(100, parseInt(e.currentTarget.value) || 1),
                        ),
                      )
                    }
                  />
                </label>
              </Show>
            </div>
          </div>

          {/* ════ Features ════ */}
          <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
            <input type="checkbox" checked />
            <div class={collapseTitleClass}>
              <Icon icon="lucide:sparkles" width="14" height="14" />
              Features
            </div>
            <div class={collapseContentGrid}>
              <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
                <span>
                  <span class="block text-sm font-medium">
                    Ping-pong effect
                  </span>
                  <span class="block text-xs text-base-content/60">
                    Mirrored loop
                  </span>
                </span>
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  checked={pipeline.usePingpong()}
                  onChange={(e) =>
                    pipeline.setUsePingpong(e.currentTarget.checked)
                  }
                />
              </label>

              <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
                <span>
                  <span class="block text-sm font-medium">Embed chapters</span>
                  <span class="block text-xs text-base-content/60">
                    Native MP4/MKV chapters
                  </span>
                </span>
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  checked={pipeline.embedChapters()}
                  onChange={(e) =>
                    pipeline.setEmbedChapters(e.currentTarget.checked)
                  }
                />
              </label>

              <label
                class="flex min-h-20 items-center justify-between gap-4 rounded-lg border-2 border-primary/30 bg-primary/5 px-4 py-3"
                data-testid="zero-reencode-toggle"
                title="When ON, the intermediate re-encode step is skipped and the source video is muxed with the audio track via -c copy. Best when source codec already matches the target. If codecs truly differ, FFmpeg will surface a clear error instead of silently re-encoding."
              >
                <span>
                  <span class="block text-sm font-semibold text-primary">
                    Skip re-encode (zero-reencode / stream copy)
                  </span>
                  <span class="block text-xs text-base-content/70">
                    Bypass the intermediate re-encode completely. Overrides
                    ping-pong and codec checks. Recommended when source codec
                    already matches target.
                  </span>
                </span>
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  checked={pipeline.skipIntermediateOnCodecMatch()}
                  onChange={(e) =>
                    pipeline.setSkipIntermediateOnCodecMatch(
                      e.currentTarget.checked,
                    )
                  }
                  aria-label="Skip re-encode (zero-reencode / stream copy)"
                />
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
