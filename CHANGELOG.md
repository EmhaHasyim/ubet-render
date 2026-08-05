# Changelog

All notable changes to **Ubet Render** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.5] — 2026-08-05

**Bug-fix release.** A full source audit (HIGH / MEDIUM / LOW severity) of
the frontend and the Rust backend surfaced 17 issues across the render-
pipeline state machine, hardware probing, virtual scrolling, persistence,
and theme handling — all fixed and covered by new tests.

### Fixed (HIGH)

- **Pause→Resume race left the UI stuck on "Rendering" forever.** The job
  loop previously used a `for_each` stream that silently dropped an
  interrupted job when the user resumed mid-pause; the backend
  `RenderControl` now carries a `terminated` flag so `resume_render`
  refuses to resume a pipeline that has committed to exiting, and the
  job loop was refactored into an explicit `while` loop that **retries
  the interrupted job in place**. Frontend: a 6-second resume watchdog
  restarts the render from the state file if a resume ack arrives
  without pipeline activity; the watchdog is cancelled by Progress /
  Stats / Done / Cancelled / FatalError / Paused events and on user
  cancel.
- **LogViewer virtual scroll broke on wrapped lines.** Line height is now
  derived from the measured monospace character width (prefix sums +
  binary search) instead of assuming one fixed line, so wrapped lines no
  longer make the content jump.
- **`createSignal` inside `<Index>` re-created thumbnail state per row.**
  Replaced with a stable `Set<string>` of failed-thumbnail paths — failed
  placeholders no longer flicker on every Progress event.
- **Startup blocked ~30 s while probing hardware encoders.** The AV1/HEVC
  encoder probes and the `-encoders` scan now run in parallel
  (`futures::join_all` + `tokio::join!`) and the results are cached in a
  `OnceLock` — worst case dropped from ~32 s to ~8 s, typically <1 s.
- **Filenames containing `:` were rejected on Linux/macOS.** The NTFS-ADS
  colon check now runs only on Windows and only detects a second colon
  after a drive letter, so files like `My:Song.mp3` are legal on Unix.
- **Renders longer than 24 h were rejected by the backend with no UI
  guard.** The duration is now clamped to 0.1–24 h in the setters, in
  `coerceConfig` (corrupt localStorage), and via `max="24"` on the
  SettingsCard input — consistent with the Rust validation.

### Fixed (MEDIUM)

- **Video ping-pong filter stretched non-16:9 sources.**
  `create_ping_pong_video` now uses `force_original_aspect_ratio=decrease`
  - black `pad` (letterbox) so portrait/square sources keep their aspect
    ratio while the output stays uniformly 1920×1080 for concat. The filter
    was extracted into `build_base_filter()` with unit tests.
- **Notification permission failure was cached as a permanent denial.**
  Transient IPC exceptions in `ensurePermission` are no longer cached, so
  a later `notify()` retries; real granted/denied decisions are still
  cached to avoid re-prompting.
- **ETA was capped at 24 h while renders may legitimately run that long.**
  The ETA display cap was raised from 24 h to 7 days; tests updated.
- **Resume produced an ETA spike.** After a resume, the first post-resume
  Progress event now establishes a fresh ETA baseline (sentinel, applied
  on both the acked-resume and the watchdog-restart paths) instead of
  reusing the pre-pause sample.
- **Hardware probe block indentation artifact** left over from the AV1
  parallelisation fix was cleaned up.
- **Dead code** (`retryJob ?? undefined`) removed from `App.tsx`.
- **"Songs per video" input capped at 50** while the setter and backend
  accept up to 100 — the `max` attribute now matches.

### Fixed (LOW)

- **Theme flash on startup & an unregistered theme.** `data-theme="dark"`
  in `index.html` was not a registered DaisyUI theme, and `:root { color-
scheme: dark }` forced native controls dark in light mode. The theme is
  now applied synchronously before the first render, `data-theme` defaults
  to the valid `business` theme, and `color-scheme` is set per theme.
- **Unhandled promise rejections in the Titlebar** window controls are now
  caught, and double-clicking the window-control buttons no longer toggles
  maximize (the Windows convention of double-click anywhere on the bar is
  preserved via stopPropagation on the button cluster).
- **Config changes could be lost on quit.** `usePersistedConfig` now
  flushes the pending debounced localStorage write synchronously on
  unmount.
- **Per-render function allocation in `SourceSelector`** moved to module
  scope (lint + micro-perf).
- **Render log files accumulated forever.** `init_logger` now prunes
  `render_YYYYMMDD_HHMMSS.log` files older than 7 days (deterministic
  timestamp parse + tests); two flaky tests sharing the `LOG_PATH` global
  were merged into one deterministic test.

---

## [0.2.4] — 2026-07-27

**Stability & observability release.** The frontend polish of 0.2.3 holds;
this release tightens the feedback loops (toast coverage, frontend
persistence, log filtering) and exposes the keyboard shortcuts dialog so
new users can discover the existing window controls.

### Added

- **Frontend logs persisted to disk.** New `log_to_file` Tauri command in
  `src-tauri/src/commands/logger.rs` accepts batched `FrontendLogEntry`
  payloads and appends them to the same `{TEMP}/ubet-render/logs/render_*.log`
  file the backend uses. Frontend-side errors and warnings are now
  inspectable after the webview is closed. Coalesced via a 500 ms debounce
  in `src/core/logger.ts` with a 100-entry cap-driven early flush so busy
  FFmpeg progress doesn't flood IPC.
- **Wider toast coverage in `usePipeline`.** Eight additional `showToast`
  call sites — hardware detection fallback (warning), drag-and-drop
  unavailability (info), bitrate validation on Start (warning),
  `handleDone` success vs warning completion, `handleFatalError` (sticky
  error), start-error catch, pause-error catch, and the debounced
  save-config IPC failure (info).
- **Job retry button.** Each row in `JobTable` whose `state === 'error'`
  now shows a `lucide:rotate-cw` retry button with `aria-label` per row.
  Wired through `usePipeline.retryJob`, which validates the render
  preconditions first and surfaces a toast when retry is impossible
  (already running, or paths unset).
- **LogViewer filter & search.** New header in `LogViewer.tsx` hosts
  three level chips (Info / Warn / Error) and a substring search input.
  The chip activation state mirrors the colour coding of `LogLine.tsx`
  via a shared `parseLevel` helper exported from
  `src/core/logLevels.ts`. The count badge toggles between the raw total
  and a `X / Y` format when filtering is active; an extra empty state
  ("No log lines match the current filter") is shown when filters narrow
  to zero rows.
- **F1 keyboard shortcuts dialog.** New `src/components/ui/ShortcutsDialog.tsx`
  modal — built on the same `<dialog>` + `rememberFocus` + `onClose`
  pattern as the existing `ConfirmDialog` — documents the global
  shortcuts registered in `App.tsx` (Ctrl+W, F11, Ctrl+Shift+M, Ctrl+1/2)
  plus the new F1 help hotkey itself. Bindings live in a
  `ShortcutsDialogBridge` component so the hotkey works regardless of
  which sub-tree has focus.

### Changed

- **Pause optimistic-state reconciliation** (from 0.2.3) was previously
  silent except for the timeout warning toast. The new `retryJob` guard
  path uses the same toast idiom to surface "Cannot retry" / "Already
  rendering" dead-click feedback.
- **LogViewer virtual scroll reset** now tracks filter/search inputs
  rather than the filtered memo, so rapidly arriving raw log lines
  don't yank the user back to the top mid-inspection.
- **README test command** updated from `bun test` to `bun run test` with
  a callout explaining that bare `bun test` activates Bun's built-in
  test runner (different API surface than Vitest).

### Fixed

- **notify.test.ts line-92 assertion** was pre-existing: the test
  assumed `log.error(msg, err)` would reach `console.error` with two
  args, but `logger.ts` concatenates into a single prefixed line. The
  assertion now checks that the formatted line contains both substrings.
- **`ShortcutsDialog` dead/risky code removed** — auto-dismissing
  sticky toasts via `querySelectorAll` and a stray `void dismissToast`
  placeholder are gone; rendering switched to idiomatic SolidJS `<For>`
  in place of `.map`.

---

## [0.2.3] — 2026-07-27

**Frontend polish & a11y release.** The audio-pipeline behaviour and the
binary/engine surface area are unchanged from `0.2.2`; this release tightens
the SolidJS dashboard and improves keyboard/screen-reader ergonomics.

### Added

- **In-app toast notification system.** A small `src/core/toast.ts` signal
  store plus a `<ToastViewport />` portal mounted in `App.tsx`. Distinct
  from `src/core/notify.ts` (which sends OS-level notifications when the
  app is in the tray) — toasts are for short, ephemeral feedback _while
  the user is looking at the app_. Auto-dismiss with configurable TTL
  (default 3500 ms), `role="status"` / `role="alert"` mapped to variant,
  dismiss button + ESC. _Currently used by `usePipeline.handlePaused` and
  `usePipeline.pauseRender`'s reconciliation timer._
- **Light / dark theme toggle.** A new `src/core/theme.ts` module persists
  the user's theme preference under `localStorage['ubetrender-theme']`
  (separate from the versioned config schema, so no migration runs).
  First-launch defaults respect `prefers-color-scheme: light` from the
  OS, otherwise falls back to the existing `business` dark theme.
  Toggle button lives in `Titlebar.tsx` next to the minimise control
  (`lucide:sun` ↔ `lucide:moon`). DaisyUI plugin in `App.css` now
  registers both `business` and `light` themes.
- **Modal focus restoration utility.** New `src/core/focus.ts` exports
  `rememberFocus()`. `ConfirmDialog` (shared) and the cancel-render
  dialog in `AppHeader.tsx` now capture `document.activeElement` before
  `showModal()` and refocus it on `onClose`, so keyboard / screen-reader
  users land back on the trigger that opened the dialog instead of being
  stranded at `<body>`.

### Changed

- **Tab keyboard navigation follows focus.** The Render / Activity tabs
  in `App.tsx` now implement the W3C ARIA tabs pattern: `tabIndex` follows
  the active tab (roving tabindex, `0` / `-1`), and the focus ring moves
  in lockstep with `ArrowLeft` / `ArrowRight` so the visible focused
  element always matches the selected tab.
- **Pause optimistic-state reconciliation.** `usePipeline.pauseRender`
  set `paused=true` optimistically before awaiting `invoke('pause_render')`.
  If the backend's `Paused` event never arrived (IPC delay, webview
  suspend, dropped channel), the UI was stuck in `running=true, paused=true`
  indefinitely. v0.2.3 schedules a 5-second reconcile timer; the timer is
  cleared by `handlePaused` on ack, by `pauseRender` on error, by
  `cancelRender`, and by the hook's `onCleanup`. On timeout the UI
  reverts to `running` and surfaces a `warning`-variant toast.

### Fixed

- **Cancel-render dialog focus loss.** (Pre-existed; a11y regression that
  went unnoted in 0.2.2.) After the cancel dialog closed, focus fell to
  `<body>`. Restored via `rememberFocus()` as described above.

---

## [0.2.2] — 2026-07-27
