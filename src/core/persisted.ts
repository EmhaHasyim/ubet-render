/**
 * Pure, framework-agnostic helpers for local-storage persistence.
 * Extracted from {@link usePersistedConfig} so they can be unit-tested without
 * SolidJS or Tauri.
 *
 * # Schema Versioning & Migration
 *
 * When the shape of {@link PersistedConfig} changes (field added / removed /
 * renamed), increment {@link STORAGE_VERSION} and add a migration function to
 * the {@link MIGRATIONS} map.  Each migration receives the stored object from
 * the previous version and returns a partial that gets merged forward through
 * every intermediate version until the current one.
 *
 * This allows users to upgrade the app without losing their saved settings.
 *
 * Field names, defaults, and coercion rules live in `core/schema.ts`; this
 * module keeps only the versioned-storage concerns (key, version, migrations).
 */
import { safeSetStorageItem } from './storage';
import {
  coerceFromRecord,
  defaultConfigRecord,
  type SchemaState,
} from './schema';

export const STORAGE_KEY = 'ubetrender-paths';
export const STORAGE_VERSION = 3;

/** The persisted config shape — field list, defaults, and coercion rules
 *  live in `core/schema.ts`; versioned-storage concerns live here. */
export type PersistedConfig = SchemaState & { version: number };

/**
 * Migration registry.
 *
 * Key = source version number (the version the stored data is currently at).
 * Value = function that receives the data object (without version field)
 *         and returns the partial updates needed to reach the *next* version.
 *
 * Example: to migrate from version 1 → 2, add:
 * ```ts
 * MIGRATIONS.set(1, (prev) => ({ newField: defaultValue }));
 * ```
 * Then increment `STORAGE_VERSION` to 2.
 */
export const MIGRATIONS = new Map<
  number,
  (prev: Record<string, unknown>) => Record<string, unknown>
>();

// v1 → v2: introduce `skipIntermediateOnCodecMatch` as an explicit opt-in
// for stream-copy without intermediate re-encode. Disabled by default (v0.2.7+
// makes this unconditional when ON, bypassing codec matching entirely).
MIGRATIONS.set(1, (_prev) => ({
  // Preserve the previous default behavior: apply the configured video
  // processing pipeline unless the user explicitly opts into stream-copy.
  skipIntermediateOnCodecMatch: false,
}));

export function getDefaultInitial(): PersistedConfig {
  return { ...defaultConfigRecord(), version: STORAGE_VERSION };
}

/** Safely coerce a parsed JSON value into a {@link PersistedConfig}.
 *  Each field is validated individually and falls back to a sensible default
 *  when the stored value is missing, wrong type, or out of range. */
function coerceConfig(raw: Record<string, unknown>): PersistedConfig {
  return { ...coerceFromRecord(raw), version: STORAGE_VERSION };
}

/** Attempt to parse saved config from localStorage. Returns defaults on any error. */
export function loadPersistedConfig(): PersistedConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultInitial();

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      // Not valid JSON object — reset
      localStorage.removeItem(STORAGE_KEY);
      return getDefaultInitial();
    }

    const storedVersion = (parsed as Record<string, unknown>).version;
    const currentVersion = STORAGE_VERSION;

    // Same version — direct coercion
    if (storedVersion === currentVersion) {
      return coerceConfig(parsed as Record<string, unknown>);
    }

    // Unknown / corrupted version — reset
    if (typeof storedVersion !== 'number' || !Number.isFinite(storedVersion)) {
      localStorage.removeItem(STORAGE_KEY);
      return getDefaultInitial();
    }

    // Stored version is OLDER than current — run migrations forward
    if (storedVersion < currentVersion) {
      let migrated: Record<string, unknown> = {
        ...(parsed as Record<string, unknown>),
      };

      for (let v = storedVersion; v < currentVersion; v++) {
        const migrateFn = MIGRATIONS.get(v);
        if (migrateFn) {
          const patch = migrateFn(migrated);
          Object.assign(migrated, patch);
        }
        migrated.version = v + 1;
      }

      // Merge over defaults so any genuinely new fields get defaults too
      const merged = { ...getDefaultInitial(), ...migrated };

      // Persist the migrated config back so next load is faster
      safeSetStorageItem(STORAGE_KEY, JSON.stringify(merged));

      return coerceConfig(merged);
    }

    // Stored version is NEWER than current (downgrade) — reset
    localStorage.removeItem(STORAGE_KEY);
    return getDefaultInitial();
  } catch (err) {
    // JSON.parse failed or localStorage unavailable – start fresh
    if (err instanceof SyntaxError) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* noop */
      }
    }
    return getDefaultInitial();
  }
}
