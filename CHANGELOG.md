# Changelog

All notable changes to **Ubet Render** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.2.2] — 2026-07-27
