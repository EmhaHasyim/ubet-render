import { createSignal, onMount, type JSX } from 'solid-js';
import { safeSetStorageItem } from '../../core/storage';

/**
 * One render-pipeline step as a standalone collapsible card.
 *
 * Layout: each step is its own bordered panel (the "stacked cards"
 * pattern used by Linear/Untitled-UI settings pages) instead of a
 * divider row inside one big card. DaisyUI's collapse mechanics drive
 * the show/hide — the invisible checkbox input overlays the title row
 * and toggles on click, while the chevron rotates via `collapse-arrow`.
 *
 * NOTE: the content wrapper MUST carry the `collapse-content` class —
 * that's what DaisyUI's CSS targets to hide/show the body
 * (content-visibility: hidden ↔ visible). Missing it silently breaks
 * collapsing: the chevron rotates but the content never folds away.
 */

// `collapse-title` is required for DaisyUI's collapse-arrow chevron to
// render; the rest of the classes refine spacing and typography.
const collapseTitleClass =
  'collapse-title flex min-h-0 items-center gap-2.5 px-4 py-3.5 pr-10 text-sm font-semibold text-base-content/85';

/** Step-number badge shown when the section is part of the render pipeline. */
const stepBadgeClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-base-300/80 bg-base-200 font-mono text-[11px] font-semibold text-base-content/55';

/** Shared collapse-content grid matching the outer grid columns. */
const collapseContentGrid =
  'collapse-content grid grid-cols-1 gap-4 px-4 pb-4 pt-1 md:grid-cols-2 xl:grid-cols-3';

const STORAGE_PREFIX = 'section.collapsed.';

/**
 * Persists expand/collapse state in localStorage per section key so the
 * user's preference survives tab switches and app restarts. Defaults to
 * expanded when no stored preference exists.
 */
export function CollapsibleSection(props: {
  title: string;
  /**
   * Render-pipeline step number (01, 02, …). When set, a numbered badge
   * replaces the icon so the setup flow reads as a clear sequence.
   */
  step?: number;
  /**
   * Unique storage key for this section. Kept as a prop so each consumer
   * can name itself; defaulted to `title` if not provided.
   */
  storageKey?: string;
  children: JSX.Element;
}) {
  const key = props.storageKey ?? props.title;
  const storageKey = () => `${STORAGE_PREFIX}${key}`;

  /** Restore persisted preference, default to expanded. */
  const readExpanded = (): boolean => {
    try {
      const raw = localStorage.getItem(storageKey());
      if (raw !== null) return raw !== '0';
    } catch {
      /* quota / disabled */
    }
    return true;
  };

  const [expanded, setExpanded] = createSignal(readExpanded());

  onMount(() => {
    // Re-read on mount in case another tab changed it.
    setExpanded(readExpanded());
  });

  const toggle = (next: boolean) => {
    setExpanded(next);
    safeSetStorageItem(storageKey(), next ? '1' : '0');
  };

  return (
    <div class="collapse collapse-arrow rounded-box border border-base-300/70 bg-base-100">
      <input
        type="checkbox"
        checked={expanded()}
        onChange={(e) => toggle(e.currentTarget.checked)}
        aria-label={`Toggle ${props.title} section`}
      />
      <div class={collapseTitleClass}>
        {props.step !== undefined && (
          <span class={stepBadgeClass}>
            {String(props.step).padStart(2, '0')}
          </span>
        )}
        {props.title}
      </div>
      <div class={collapseContentGrid}>{props.children}</div>
    </div>
  );
}
