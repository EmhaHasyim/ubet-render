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

## [0.2.2] — 2026-07-27
