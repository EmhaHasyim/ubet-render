import { Icon } from '@iconify-icon/solid';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../core/config';
import { SourceSelector } from '../media/SourceSelector';
import { TAURI_COMMANDS } from '../../core/constants';
import { usePipelineContext } from '../../context/pipeline';
import { normalizeBitrate } from '../../core/estimate';
import { createLogger } from '../../core/logger';
import { OutputFolderSelector } from './OutputFolderSelector';
import { AudioSection } from './AudioSection';
import { VideoEncodingSection } from './VideoEncodingSection';
import { LoopingSection } from './LoopingSection';
import { FeaturesSection } from './FeaturesSection';

// Replaces 1 ad-hoc console.error call; see `src/core/logger.ts`.
const log = createLogger('SettingsCard');

// Stable empty array so the binding doesn't allocate a fresh `[]` on every
// reactive re-evaluation when the source is unset.
const EMPTY_PATHS: string[] = [];

/** Extract file paths from a MediaSource regardless of variant. */
function getSourcePaths(
  source: { type: string; paths?: string[]; path?: string } | null,
): string[] {
  if (source?.type === 'files' && source.paths) return source.paths;
  if (source?.type === 'folder' && source.path) return [source.path];
  return EMPTY_PATHS;
}

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

  const revealFile = async () => {
    try {
      const path = pipeline.outputPath();
      if (path) await invoke(TAURI_COMMANDS.revealInExplorer, { path });
    } catch (e) {
      log.error('Failed to reveal folder:', e);
    }
  };

  const handleMaxrateBlur = (raw: string) => {
    const normalized = normalizeBitrate(raw);
    if (normalized !== raw) {
      pipeline.setMaxrate(normalized);
    }
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

        <div id="output-dropzone">
          <OutputFolderSelector
            outputPath={pipeline.outputPath}
            dropClass={dropState('output')}
            onChooseFolder={chooseOutput}
            onReveal={revealFile}
          />
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
          <AudioSection
            songsPerPlaylist={pipeline.songsPerPlaylist}
            audioMode={pipeline.audioMode}
            onSongsChange={(v) => pipeline.setSongsPerPlaylist(v)}
            onModeChange={(v) => pipeline.setAudioMode(v)}
          />

          <VideoEncodingSection
            codec={pipeline.codec}
            av1Supported={pipeline.av1Supported}
            maxrate={pipeline.maxrate}
            maxrateValid={pipeline.maxrateValid}
            outputFormat={pipeline.outputFormat}
            outputPrefix={pipeline.outputPrefix}
            onCodecChange={(v) => pipeline.setCodec(v)}
            onMaxrateChange={(v) => pipeline.setMaxrate(v)}
            onMaxrateBlur={handleMaxrateBlur}
            onFormatChange={(v) => pipeline.setOutputFormat(v)}
            onPrefixChange={(v) => pipeline.setOutputPrefix(v)}
          />

          <LoopingSection
            loopMode={pipeline.loopMode}
            minDurationHours={pipeline.minDurationHours}
            loopCount={pipeline.loopCount}
            onModeChange={(v) => pipeline.setLoopMode(v)}
            onDurationChange={(v) => pipeline.setMinDurationHours(v)}
            onCountChange={(v) => pipeline.setLoopCount(v)}
          />

          <FeaturesSection
            usePingpong={pipeline.usePingpong}
            embedChapters={pipeline.embedChapters}
            skipIntermediateOnCodecMatch={pipeline.skipIntermediateOnCodecMatch}
            onPingpongChange={(v) => pipeline.setUsePingpong(v)}
            onChaptersChange={(v) => pipeline.setEmbedChapters(v)}
            onSkipReencodeChange={(v) =>
              pipeline.setSkipIntermediateOnCodecMatch(v)
            }
          />
        </div>
      </div>
    </section>
  );
}
