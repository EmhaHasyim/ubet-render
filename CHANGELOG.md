# Changelog

All notable changes to **Ubet Render** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.1] — 2026-07-25

**Housekeeping release.** No new features. The pipeline, UI, and rendering
behaviour are unchanged from `0.2.0`.

### Changed

- **Version sync.** `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, and `README.md` now all pin to `0.2.1`
  (previously drifted to `0.1.2` despite the `0.2.0` tag).
- **CI coverage.** `.github/workflows/ci.yml` now validates
  **pull requests opened against `dev`** in addition to `main`. PRs against
  the active development branch were previously skipped.
- **Single source of truth for media extensions.** The canonical list now
  lives in [`docs/MEDIA_EXTENSIONS.md`](./docs/MEDIA_EXTENSIONS.md) instead
  of being implicit between `src/core/config.ts` and the Rust
  `validation.rs` / `source_scanner.rs`. Drift between the two sides is
  now caught by cross-language tests.

### Added

- [`CHANGELOG.md`](./CHANGELOG.md) — this file, retroactively documenting
  housekeeping work going forward.
- [`docs/MEDIA_EXTENSIONS.md`](./docs/MEDIA_EXTENSIONS.md) — canonical allow-list
  for the formats the pipeline knows how to read. Referenced from both
  the SolidJS frontend (`src/core/config.ts`) and the Rust backend
  (`src-tauri/src/pipeline/source_scanner.rs`,
  `src-tauri/src/validation.rs`).
- **Drift-detection tests.** Rust (`validation.rs`) and TypeScript
  (`config.test.ts`) now both assert their arrays equal the canonical list,
  so the next person to add a new format will see a failing test if they
  forget to update both sides.

### Documentation

- README: replaced drifted mentions of `createFallbackPipeline()` / internal
  component names with the actual current implementation
  (`PipelineBridge` inside `App.tsx`). Test-count line is now generic
  ("comprehensive Vitest + Rust suite") instead of an exact number that
  drifts after every test is added.

### Maintenance

- `.gitignore`: explicitly ignores `/coverage/` (the Vitest HTML report
  output directory that was previously committed). If you have an
  in-tree `coverage/` already, run `git rm -r --cached coverage/` once
  to drop it from tracking.

---

## [0.2.0] — 2026-07-19

Release after the engine-rewrite milestone. Specific behaviour deltas
versus `0.1.2` are listed below; for the full architectural picture, refer
to the README.

### Changed

- Render pipeline: zero-reencode muxing (`-c copy` for codec-matched
  sources), ping-pong mirror with Lanczos upscaling and unsharp masking,
  per-render smart shuffle.
- Hardware encoder auto-selection (NVENC / AMF / QSV, with SVT-AV1 /
  x264 / x265 software fallback when no compatible GPU is detected).
- localStorage settings upgraded to a versioned schema with a forward
  migration registry (`STORAGE_VERSION` incremented).
- CI runs on pushes to `main` / `dev` and on PRs against `main`.

### Notes

- The previously shipped format allow-list lives in
  `docs/MEDIA_EXTENSIONS.md`. Drift between the TS and Rust
  implementations is now caught by parallel sentinel lists in
  `config.test.ts` and `validation.rs::tests`.

---

## [0.1.2] — 2026-07-10

Last pre-public-release iteration. Internal-only.

- Outcome-based encode selector (target → encoder name).
- Trivial ring buffer for log lines.
- Initial `useHardware` hook (CPU/RAM/AV1 detection).
