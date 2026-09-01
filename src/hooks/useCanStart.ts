import { createMemo, type Accessor } from 'solid-js';
import { isMaxrateValid } from '../core/estimate';
import { CODECS, getSourcePaths } from '../core/config';
import type { HardwareInfo } from './useHardware';

interface StartReadinessConfig {
  videoSource: Accessor<import('../core/types').MediaSource | null>;
  audioSource: Accessor<import('../core/types').MediaSource | null>;
  outputPath: Accessor<string>;
  maxrate: Accessor<string>;
  codec: Accessor<string>;
}

/**
 * Start-readiness validation: whether a render may start, and if not, why.
 * Pure derivation from config + hardware — no IPC, no lifecycle.
 */
export function useCanStart(
  config: StartReadinessConfig,
  hardwareInfo: Accessor<HardwareInfo | null>,
) {
  const videoSourceReady = () =>
    getSourcePaths(config.videoSource()).length > 0;

  const audioSourceReady = () =>
    getSourcePaths(config.audioSource()).length > 0;

  const outputPathReady = () => config.outputPath().length > 0;

  const pathsReady = () =>
    videoSourceReady() && audioSourceReady() && outputPathReady();

  const maxrateValid = () => isMaxrateValid(config.maxrate());

  const canStart = () => {
    const info = hardwareInfo();
    if (!pathsReady() || info === null) return false;
    if (config.codec() === CODECS.av1 && !info.av1Supported) return false;
    return maxrateValid();
  };

  const disabledReason = createMemo(() => {
    const info = hardwareInfo();
    if (info === null) return 'Detecting hardware...';
    if (!videoSourceReady()) return 'Select a video source';
    if (!audioSourceReady()) return 'Select audio tracks';
    if (!outputPathReady()) return 'Choose an output folder';
    if (config.codec() === CODECS.av1 && !info.av1Supported)
      return 'AV1 not supported by your hardware';
    if (!maxrateValid()) return 'Enter a valid bitrate (100–50000)';
    return '';
  });

  return { canStart, maxrateValid, disabledReason };
}
