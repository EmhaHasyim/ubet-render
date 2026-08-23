# Changelog

All notable changes to Ubet Render are documented in this file.

---

## [0.2.7] — 2026-08-23

### Fixed

- Removed the stray `nul` file (Windows `> nul` redirect artifact) from the repository root. It was already listed in `.gitignore` but had been committed before the ignore rule was added.
- **Logger timestamp alignment:** `formatTimestamp()` now uses UTC (`getUTCHours()` etc.) instead of local time, matching the Rust backend's `chrono::Utc` — frontend and backend log timestamps are now always in sync regardless of timezone.
- **Fullscreen state corruption:** `useAppShortcuts` no longer uses a broken `fullscreenStateResolved` flag that could leave the toggle stuck in the wrong state. Detection is now a simple direct assignment from the Tauri probe.
- **Dead signal removed:** the unused `dirty` signal in `usePipelinePersistence` has been removed (no consumer ever read it).
- **EMPTY_PATHS hardening:** the shared sentinel array is now `readonly` + `Object.freeze()` to prevent accidental mutation by any consumer.
- **Collapsible sections toggle:** sections now use a reactive signal instead of a hardcoded `checked` attribute, so users can collapse them.
- **formatDuration polish:** removed redundant seconds display (`5m 0s left` → `5m left`), rounds up sub-minute durations to `< 1m left`.
- **Job processor simplification:** the `skipIntermediateOnCodecMatch` toggle now unconditionally stream-copies source video regardless of codec, rather than requiring an exact codec match — fulfilling the original "zero re-encode" promise.
- **Version sync:** `Cargo.toml` bumped to 0.2.7 (was 0.2.6) so Tauri metadata matches `package.json`.

### Changed

- Extracted `LOUDNORM_PARAMS` as a named constant in `core/config.ts` (replaces the inline magic string in `DEFAULT_CONFIG.audio.loudnormParams`).
- Moved `EMPTY_PATHS` and `getSourcePaths()` from `SettingsCard.tsx` into `core/config.ts` so they can be reused by any future source-picker component without duplication.
- Replaced the manual `jobs.some(j => j.state === 'error')` loop in `Dashboard.tsx`'s taskbar progress effect with a `hasFailed` derived signal on the pipeline context, so the iterator in `StatsStrip` stays the single source of truth for job-state metrics.
- Used TypeScript's `satisfies` operator on `LEVEL_CHIPS` in `LogViewer.tsx` and `statusMap` in `StatusBadge.tsx` for extra compile-time safety without widening the inferred literal types.
- Replaced 6+ scattered string literals (`'h264'`, `'h265'`, `'av1'`) with the `CODECS` constant object + `CodecId` type in `core/config.ts`, used by `persisted.ts`, `useHardware.ts`, and `usePipeline.ts`.
- `useProgressTracker` no longer exposes internal fields (`getStartProgress`, `setStartProgress`, `getStartTime`, `etaCalculator`) on its public interface — they are still passed to `createPipelineEventHandler` via closure scope but are hidden from casual consumers.
- `usePipeline` now explicitly re-exports each config accessor/setter instead of `...config`, making the public API surface auditable at the return statement.
- Added a max-depth guard (256 levels) to `canonicalize_lenient` in the Rust validation layer to prevent infinite loops on malformed or adversarial paths.
- Log prefixes are now consistently bracket-style (`[FATAL]`, `[WARN]`) across all pipeline event handlers.
- Removed dead `MAX_ETA_SAMPLES` constant from `useProgressTracker`.
- Updated the "Skip re-encode" toggle label and tooltip to reflect the new unconditional stream-copy behavior (no longer mentions codec matching).

### Added

- New `typecheck` script (`tsc --noEmit`) in `package.json` — now CI and contributors can run `bun run typecheck` alongside `bun run lint`.

---

## [0.2.6] — 2026-07-25

### Added

- Centralized logger (`src/core/logger.ts`) replacing 11 scattered `console.error` / `console.warn` calls across the production codebase. Each call site now uses a pre-bound `createLogger(context)` that formats logs as `[timestamp] [context] message` and forwards them to the Rust backend's file sink on a 500 ms debounce.
- Toast notification system (`src/core/toast.ts` + `src/components/ui/Toast.tsx`) for short, ephemeral in-app feedback (distinct from OS-level notifications). Toasts auto-dismiss on a configurable TTL and are rendered via a `<Portal>` in the bottom-right corner.
- ETA calculator (`src/core/eta.ts`) using an exponential moving average of the rate (% per ms) so the progress bar reacts quickly to stalls while smoothing noise from individual FFmpeg progress lines.
- Focus restoration utility (`src/core/focus.ts`) — `rememberFocus()` captures `document.activeElement` before opening a modal and returns a callback that restores focus after the modal closes. Used by `ConfirmDialog`, `AppHeader`, and `ShortcutsDialog`.
- Virtual scrolling in `LogViewer` with height-aware row estimation based on measured monospace character width — handles wrapped lines (long FFmpeg output in narrow panels) without misaligning the scroller.
- Level filter chips (Info / Warn / Error) and a full-text search box in `LogViewer` so users can narrow the log stream by severity or keyword.
- Shortcuts dialog (`F1`) documenting all keyboard shortcuts: `F11` (fullscreen), `Ctrl+W` (hide to tray), `Ctrl+Shift+M` (minimize), `Ctrl+1` / `Ctrl+2` (switch tabs).
- Ring buffer (`src/core/ringBuffer.ts`) — pre-allocated array of 2000 entries for log lines and ETA samples to avoid GC pressure during high-frequency FFmpeg output.
- Log-level parsing module (`src/core/logLevels.ts`) — shared `parseLevel()` used by both `LogLine` (colour) and `LogViewer` (filter chips), guaranteeing those two sites never drift.
- Schema versioning and migration system in `core/persisted.ts` — `STORAGE_VERSION` tracks the current schema, `MIGRATIONS` map defines forward transforms so users never lose settings on upgrade.
- `Storage` wrapper (`src/core/storage.ts`) — single `safeSetStorageItem()` helper that swallows quota / disabled-storage errors, replacing three duplicate try/catch blocks.
- `buildAppConfig` / `BackendConfigSnapshot` — extracted the frontend→backend config bridge from `usePipelinePersistence` into a pure module (`src/core/buildAppConfig.ts`) for unit-testability.
- `useProgressTracker` hook — extracted progress signals, baseline state, and ETA calculator from `usePipeline` into a self-contained module.
- `pipelineEvents` handler factory — isolated event-to-state transitions (Progress, Done, Paused, Cancelled, FatalError) from the lifecycle-aware `usePipeline` orchestrator.
- Pipeline persistence with retry (`usePipelinePersistence`) — debounced saves to the Rust backend with exponential backoff (3 retries) so transient IPC/filesystem failures don't lose settings.
- Media source selector with clear-confirmation dialog (`SourceSelector`) — file picker with extension filtering, last-directory memory, and a "Clear" button guarded by `ConfirmDialog`.
- Output folder selector (`OutputFolderSelector`) with "Open in Explorer" button.
- Extracted collapsible section sections: `AudioSection`, `VideoEncodingSection`, `LoopingSection`, `FeaturesSection` — each is a self-contained component feeding into a reusable `CollapsibleSection` wrapper.
- Comprehensive test suite: 402 tests across 42 files covering core utilities, hooks (unit + integration), components (unit + extended coverage), contracts (golden tests), and the pipeline context contract.

### Changed

- Moved `usePipeline()` call from the top of `App` into a `PipelineBridge` component wrapped by `<ErrorBoundary>`. If `usePipeline` throws during initialization, `FatalScreen` presents a "Try Again" button that remounts the bridge without losing the application shell.
- Replaced 17 individual `createSignal` calls in `usePersistedConfig` with a single `createStore` — all fields share one reactive root, reducing SolidJS dependency tracking overhead.
- Extracted `AppHeader` + `HardwareInfo` + `OverallProgress` into separate components from the monolithic dashboard.
- Extracted `Titlebar` with drag region, window controls (minimize/maximize/close), theme toggle, and right-click context menu.
- Extracted `StatsStrip` with single-pass memoized job-state counters and a placeholder skeleton when idle.
- Consolidated keyboard shortcut handling into `useAppShortcuts` hook (was scattered across `Titlebar`, tab navigation, and the shortcuts dialog).
- Centralized Tauri command and event name constants in `core/constants.ts`.
- Theme persistence uses a separate `ubetrender-theme` localStorage key (not mixed into `PersistedConfig`) so UI cosmetics never trigger schema migrations.
- Notification permission is cached for the session after first grant/deny to avoid re-requesting on every `notify()` call.
- Pause render includes a 5-second reconciliation timer — if the backend never acknowledges the pause, the UI auto-returns to "running" so the user isn't stranded.

### Fixed

- Fixed theme flash on launch: `applyTheme(loadTheme())` now runs synchronously before the first `render()` call in `index.tsx`, so the browser never paints the wrong theme.
- Fixed "Resume" incorrectly restarting from scratch when the backend pipeline was still alive — now checks the return value before falling back to `startRender(true)`.
- Fixed taskbar progress bar not clearing after render completion on Windows.
- Fixed drag-and-drop coordinate scaling for HiDPI displays: Tauri native DnD events now divide position by `devicePixelRatio` so hit-testing aligns with the DOM.
