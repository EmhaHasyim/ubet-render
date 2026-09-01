import { createMemo, createSignal } from 'solid-js';
import {
  FILTERABLE_LEVELS,
  parseLevel,
  type LogLevel,
} from '../core/logLevels';
import { safeSetStorageItem } from '../core/storage';

const ALL_LEVELS: LogLevel[] = FILTERABLE_LEVELS;

function readEnabledLevels(): Set<LogLevel> {
  try {
    const raw = localStorage.getItem('logs.filter.levels');
    if (raw) {
      const parsed = raw
        .split(',')
        .filter((level) =>
          ALL_LEVELS.includes(level as LogLevel),
        ) as LogLevel[];
      if (parsed.length > 0) return new Set(parsed);
    }
  } catch {
    /* quota / disabled */
  }
  return new Set(ALL_LEVELS);
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
    safeSetStorageItem('logs.filter.query', value);
  };

  const filteredLogs = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const levels = enabledLevels();
    const allOn = levels.size === ALL_LEVELS.length;

    return logs().filter((line) => {
      if (!allOn && !levels.has(parseLevel(line) ?? 'INFO')) return false;
      return !query || line.toLowerCase().includes(query);
    });
  });

  const isFiltering = createMemo(
    () =>
      enabledLevels().size !== ALL_LEVELS.length ||
      searchQuery().trim().length > 0,
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
