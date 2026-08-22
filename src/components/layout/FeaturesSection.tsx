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
    <CollapsibleSection icon="lucide:sparkles" title="Features">
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
        class="flex min-h-20 items-center justify-between gap-4 rounded-lg border-2 border-primary/30 bg-primary/5 px-4 py-3"
        data-testid="zero-reencode-toggle"
        title="When ON and the source codec matches the target, the intermediate encode is skipped and the source is muxed via -c copy. A codec mismatch safely uses the normal encode path."
      >
        <span>
          <span class="block text-sm font-semibold text-primary">
            Skip re-encode (zero-reencode / stream copy)
          </span>
          <span class="block text-xs text-base-content/70">
            Bypass the intermediate re-encode completely. Use only when the
            source codec already matches the target; this also disables
            ping-pong processing.
          </span>
        </span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          checked={props.skipIntermediateOnCodecMatch()}
          onChange={(e) => props.onSkipReencodeChange(e.currentTarget.checked)}
          aria-label="Skip re-encode (zero-reencode / stream copy)"
        />
      </label>
    </CollapsibleSection>
  );
}
