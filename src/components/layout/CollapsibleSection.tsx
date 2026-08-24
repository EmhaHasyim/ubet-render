import { createSignal, onMount, type JSX } from 'solid-js';
import { Icon } from '@iconify-icon/solid';
import { safeSetStorageItem } from '../../core/storage';

/** Shared collapse-title classes for consistent section headers. */
const collapseTitleClass =
  'text-sm font-semibold uppercase tracking-wider text-base-content/60 flex items-center gap-2';

/** Shared collapse-content grid matching the outer grid columns. */
const collapseContentGrid =
  'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 pt-1';

const STORAGE_PREFIX = 'section.collapsed.';

/**
 * Reusable DaisyUI collapse section wrapper used by all render-option
 * sections (Audio, Video & Encoding, Looping, Features).
 *
 * Persists expand/collapse state in localStorage per section key so the
 * user's preference survives tab switches and app restarts. Defaults to
 * expanded when no stored preference exists.
 */
export function CollapsibleSection(props: {
  icon: string;
  title: string;
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
    <div class="col-span-full collapse collapse-arrow bg-base-100 rounded-lg border border-base-300">
      <input
        type="checkbox"
        checked={expanded()}
        onChange={(e) => toggle(e.currentTarget.checked)}
        aria-label={`Toggle ${props.title} section`}
      />
      <div class={collapseTitleClass}>
        <Icon icon={props.icon} width="14" height="14" />
        {props.title}
      </div>
      <div class={collapseContentGrid}>{props.children}</div>
    </div>
  );
}
