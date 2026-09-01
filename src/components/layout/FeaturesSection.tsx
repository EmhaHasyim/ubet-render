import { CollapsibleSection } from './CollapsibleSection';
import type { Accessor } from 'solid-js';

/**
 * Feature toggles: ping-pong, embed chapters, skip re-encode.
 * Content for the "Features" collapsible section.
 */
export function FeaturesSection(props: {
  usePingpong: Accessor<boolean>;
  embedChapters: Accessor<boolean>;
  skipIntermediateOnCodecMatch: Accessor<boolean>;
  onPingpongChange: (v: boolean) => void;
  onChaptersChange: (v: boolean) => void;
  onSkipReencodeChange: (v: boolean) => void;
}) {
  return (
    <CollapsibleSection step={5} title="Features">
      <label class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3">
        <span>
          <span class="block text-sm font-medium">Ping-pong effect</span>
          <span class="block text-xs text-base-content/60">Mirrored loop</span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.usePingpong()}
          onChange={(e) => props.onPingpongChange(e.currentTarget.checked)}
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
          checked={props.embedChapters()}
          onChange={(e) => props.onChaptersChange(e.currentTarget.checked)}
        />
      </label>

      <label
        class="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-base-300 bg-base-100 px-4 py-3"
        data-testid="zero-reencode-toggle"
        title="Copies the source video without re-encoding. Faster, but the output codec follows the source file and ping-pong is disabled."
      >
        <span>
          <span class="inline-flex items-center gap-2 text-sm font-medium">
            Skip re-encode
            <span class="badge badge-xs badge-outline text-[0.625rem]">
              ADVANCED
            </span>
          </span>
          <span class="block text-xs text-base-content/60">
            Copy the source video without re-encoding — faster, but the output
            codec follows the source file and ping-pong is off.
          </span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.skipIntermediateOnCodecMatch()}
          onChange={(e) => props.onSkipReencodeChange(e.currentTarget.checked)}
          aria-label="Skip re-encode (direct stream copy)"
        />
      </label>
    </CollapsibleSection>
  );
}
