import { createMemo, createSignal, onCleanup } from 'solid-js';
import {
  FILTERABLE_LEVELS,
  parseLevel,
  type LogLevel,
} from '../core/logLevels';
import { safeSetStorageItem } from '../core/storage';

function readEnabledLevels(): Set<LogLevel> {
  try {
    const raw = localStorage.getItem('logs.filter.levels');
    if (raw) {
      const parsed = raw
        .split(',')
        .filter((level) =>
          FILTERABLE_LEVELS.includes(level as LogLevel),
        ) as LogLevel[];
      if (parsed.length > 0) return new Set(parsed);
    }
  } catch {
    /* quota / disabled */
  }
  return new Set(FILTERABLE_LEVELS);
}

function readSearchQuery(): string {
  try {
    return localStorage.getItem('logs.filter.query') ?? '';
  } catch {
    return '';
  }
}

export function useLogFilter(logs: () => string[]) {
  const [enabledLevels, setEnabledLevels] =
    createSignal<Set<LogLevel>>(readEnabledLevels());
  const [searchQuery, setSearchQuery] = createSignal(readSearchQuery());
  // Debounced query drives the expensive 2000-line filter; raw input stays
  // responsive while `filteredLogs` recomputes at most every 150ms.
  const [debouncedQuery, setDebouncedQuery] = createSignal(readSearchQuery());
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let storageTimer: ReturnType<typeof setTimeout> | null = null;

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      safeSetStorageItem('logs.filter.levels', [...next].join(','));
      return next;
    });
  };

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      setDebouncedQuery(value);
    }, 150);
    // Coalesce rapid keystrokes into one storage write.
    if (storageTimer !== null) clearTimeout(storageTimer);
    storageTimer = setTimeout(() => {
      storageTimer = null;
      safeSetStorageItem('logs.filter.query', value);
    }, 300);
  };

  onCleanup(() => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    if (storageTimer !== null) clearTimeout(storageTimer);
  });

  const filteredLogs = createMemo(() => {
    const query = debouncedQuery().trim().toLowerCase();
    const levels = enabledLevels();
    const allOn = levels.size === FILTERABLE_LEVELS.length;

    return logs().filter((line) => {
      const level = parseLevel(line);
      // SUCCESS has no toggle chip (see FILTERABLE_LEVELS), so a success
      // line must stay visible under any filter combination — otherwise
      // disabling one chip would silently drop every `[SUCCESS]` line with
      // no way to bring them back.
      if (level !== 'SUCCESS' && !allOn && !levels.has(level ?? 'INFO')) {
        return false;
      }
      return !query || line.toLowerCase().includes(query);
    });
  });

  // Must match what `filteredLogs` actually applies. Using the raw query here
  // made the toolbar claim a filter was active during the 150 ms debounce,
  // while the list still showed unfiltered lines.
  const isFiltering = createMemo(
    () =>
      enabledLevels().size !== FILTERABLE_LEVELS.length ||
      debouncedQuery().trim().length > 0,
  );

  return {
    enabledLevels,
    searchQuery,
    filteredLogs,
    isFiltering,
    toggleLevel,
    handleSearchInput,
  };
}
