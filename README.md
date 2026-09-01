# Ubet Render

My personal offline-first engine that automates video-looping and audio-playlist muxing. Built because manually stretching timelines, setting up ping-pong loops, and compiling tracklists in Premiere / FFmpeg CLI for hours was driving me insane.

It behaves like a modern SaaS dashboard but runs entirely local on your machine. No web uploads, no cloud rendering fees, no external trackers — just raw, hardware-accelerated processing powered by Rust & FFmpeg.

---

## The Problem

Making long-form looped videos (1-hour lo-fi mixes, stream screens, ambient soundscapes) usually requires:

1. Exporting a perfectly looped video (often with backward mirroring so the cut isn't jarring).
2. Stretching that loop to fit a compilation of audio tracks, then manually writing down timestamps for YouTube.

**Ubet Render does both in one click.** Feed it a video, point it to your audio folder, specify a target duration, and it compiles the final output using stream-copying — no redundant re-encoding after the initial loop template is prepared.

### Key Features

- **Ping-Pong Mirroring**: Seamlessly mirrors short clips (A → B → A) with Lanczos upscaling and subtle unsharp masking.
- **Zero-Reencode Muxing (opt-in)**: When enabled, the source video is stream-copied directly into the final output — no intermediate re-encode, regardless of codec. Disabled by default so ping-pong processing works out of the box.
- **Smart Playlists**: Shuffles audio tracks up to your target duration (1h, 10h, etc.) and handles the math.
- **Auto-Generated Timestamps**: Produces a compact `all_timestamps.txt` with YouTube-compliant timestamps (`00:00` or `00:00:00`) for copy-paste into video descriptions. Each song is listed once, plus an optional `"Looping"` end-marker.
- **Hardware-Aware**: Auto-selects NVENC, AMF, or QSV acceleration at startup; falls back to software (SVT-AV1, x264, x265) when no GPU is detected.

---

## Tech Stack

| Layer                     | Technology                                                                       | Why                                                            |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Frontend framework**    | [SolidJS](https://www.solidjs.com/) v1.9                                         | Fine-grained reactivity, no virtual DOM overhead, tiny bundles |
| **UI toolkit**            | [Tailwind CSS](https://tailwindcss.com/) v4 + [DaisyUI](https://daisyui.com/) v5 | Utility-first + pre-built components for rapid, consistent UIs |
| **Icons**                 | [Lucide](https://lucide.dev/) via `@iconify-icon/solid`                          | Consistent, tree-shakeable icon set                            |
| **Desktop wrapper**       | [Tauri](https://v2.tauri.app/) v2                                                | OS integration, Rust bridge, tiny binary size (~5 MB)          |
| **Core engine**           | Rust (tokio async + FFmpeg wrappers)                                             | Safe, fast, predictable                                        |
| **Build tool**            | [Vite](https://vite.dev/) v8                                                     | Lightning-fast HMR and bundling                                |
| **Runtime / package mgr** | [Bun](https://bun.sh/)                                                           | Fast installs and scripts                                      |
| **Linting**               | [oxlint](https://oxc.rs/)                                                        | Rust-based linter, ~50× faster than ESLint                     |
| **Formatting**            | [oxfmt](https://oxc.rs/)                                                         | Rust-based formatter                                           |
| **Testing**               | [Vitest](https://vitest.dev/) v4 + jsdom + `@solidjs/testing-library`            | Fast, native ESM test runner                                   |
| **Pre-commit**            | Husky + lint-staged                                                              | Automated lint/format on every commit                          |

---

## Frontend Architecture

```
src/
├── App.tsx                # Root component: layout shell, ErrorBoundary, tab routing
├── App.css                # Global styles, Tailwind plugins, DaisyUI theme, animations
├── index.tsx              # Entry point
│
├── core/                  # Pure, framework-agnostic logic
│   ├── types.ts           # Shared TypeScript types & interfaces
│   ├── config.ts          # Default config values, file-extension lists
│   ├── estimate.ts        # Bitrate validation, ETA formatting
│   └── persisted.ts       # localStorage persistence, schema versioning & migration
│
├── context/               # SolidJS context providers
│   └── pipeline.tsx        # PipelineContext + PipelineProvider (wrapped at call-site by PipelineBridge in App.tsx)
│
├── hooks/                 # Custom SolidJS hooks
│   ├── usePipeline.ts     # Central orchestrator: wires config, hardware, DnD, IPC events
│   ├── usePersistedConfig.ts  # Persisted settings via createStore (single reactive root)
│   ├── useHardware.ts     # Hardware detection, encoder selection per GPU vendor
│   └── useDragDrop.ts     # Tauri-native + HTML5 drag-and-drop (dual fallback)
│
└── components/
    ├── index.ts           # Barrel exports
    ├── layout/            # Page-level layout components
    │   ├── AppHeader.tsx     # Start/Pause/Cancel controls with cancel dialog
    │   ├── SettingsCard.tsx  # Sources, output, encoding, looping, features
    │   ├── StatsStrip.tsx    # KPI strip (jobs, progress, live stats)
    │   ├── JobTable.tsx      # Job queue with thumbnails and progress bars
    │   └── LogViewer.tsx     # Virtual-scrolled log viewer (2000+ lines)
    ├── media/             # Media source selection
    │   └── SourceSelector.tsx  # File picker with file list display
    └── ui/                # Small, reusable presentational components
        ├── FatalScreen.tsx     # Full-screen error boundary fallback
        ├── HardwareInfo.tsx    # CPU/GPU/RAM/AV1 status card
        ├── LogLine.tsx         # Single log line with level-based colouring
        ├── OverallProgress.tsx # Global progress bar with ETA
        └── StatusBadge.tsx     # Pending/Processing/Done/Error badge
```

### Component Tree (simplified)

```
<App>
  <ErrorBoundary fallback={<FatalScreen />}>
    <PipelineBridge>          {/* calls usePipeline() inside the boundary */}
      ┌─ Header bar ─────────────────────────────┐
      │  Logo · Title · Tabs · Status badges     │
      └───────────────────────────────────────────┘
      ┌─ Main content ───────────────────────────┐
      │                                          │
      │  [Tab: Renderer]                         │
      │  ┌─ StatsStrip ──────────────────────┐   │
      │  │  Jobs · Done · Failed · % · Live  │   │
      │  └───────────────────────────────────┘   │
      │  ┌─ Grid ───────────────────────────┐   │
      │  │  SettingsCard              │     │   │
      │  │  (sources, options)        │     │   │
      │  │                            │     │   │
      │  │                     ┌──────┤     │   │
      │  │                     │ AppHeader  │   │
      │  │                     │ Hardware   │   │
      │  │                     │ Progress   │   │
      │  │                     └──────┘     │   │
      │  └──────────────────────────────────┘   │
      │                                          │
      │  [Tab: Activity]                         │
      │  ┌─ Grid ───────────────────────────┐   │
      │  │  JobTable                 │ Logs │   │
      │  │  (queue, progress,       │ (virtual   │
      │  │   thumbnails)            │  scrolled) │
      │  └──────────────────────────────────┘   │
      └──────────────────────────────────────────┘
    </PipelineBridge>
  </ErrorBoundary>
</App>
```

### Data Flow

```
User action (click / drag / input)
       │
       ▼
Component calls pipeline setter (e.g. `pipeline.setCodec('h265')`)
       │
       ├─▶ SolidJS signal/store updates reactively
       │        │
       │        ├─▶ UI re-renders affected components
       │        │
       │        └─▶ createEffect auto-persists to localStorage (300ms debounce)
       │                          └─▶ invoke('save_config') to backend (500ms debounce)
       │
       └─▶ When "Start" clicked:
                └─▶ usePipeline.startRender()
                      ├─▶ listen('pipeline-event') → event handler
                      ├─▶ invoke('start_render', { config, overrides })
                      └─▶ Events received:
                            ├─ Log     → appendLog() → virtual-scrolled LogViewer
                            ├─ Stats   → liveStats() → StatsStrip
                            ├─ Progress → jobs() + overallProgress() → JobTable + Progress bars
                            ├─ Done     → setRunning(false) + notify()
                            ├─ Paused   → setPaused(true) + keep listener alive
                            ├─ Cancelled → cleanup + notify()
                            └─ FatalError → cleanup + notify()
```

---

## Key Implementation Patterns

### 1. Virtual Scrolling (LogViewer)

The log viewer uses a **padding-trick virtual scroller** instead of rendering all 2000+ log lines into the DOM:

- A `ResizeObserver` tracks the viewport height.
- On scroll, only ~30–50 visible items + overscan are rendered.
- Correct scroll height is maintained via `padding-top` and `padding-bottom` on a wrapper `<div>`.
- Auto-scroll only triggers when the user is near the bottom; scrolling up pauses auto-scroll.

### 2. Ring Buffer for Logs + ETA

To avoid GC pressure during high-frequency FFmpeg output:

- **Log ring buffer**: Pre-allocated array of 2000 entries. New lines overwrite old ones. Flushed to the SolidJS signal every 10 lines via `flushLogs()`.
- **ETA ring buffer**: Pre-allocated array of 10 `{ elapsed, gained }` samples. A sliding-window average estimates remaining time without allocations.

### 3. Error Boundary + Recoverable Pipeline Bridge

- `<ErrorBoundary>` wraps the entire app and displays `<FatalScreen>` on uncaught errors.
- `usePipeline()` is called inside a dedicated `PipelineBridge` component so that, if it throws during initialisation (corrupt localStorage, missing Tauri IPC, etc.), the boundary catches it and renders `<FatalScreen>`. The "Try Again" button remounts the bridge and retries the call without losing the application shell.
- Every sub-hook (`useHardware`, `useDragDrop`, `usePersistedConfig`) is wrapped in its own `try-catch` so one failure doesn't cascade.

### 4. localStorage Schema Versioning

Persisted settings use a versioned schema with a migration system:

- `STORAGE_VERSION` tracks the current schema version.
- A `MIGRATIONS` map stores migration functions keyed by source version.
- When the stored version is older than current, migrations run in sequence to transform the data forward.
- Unknown fields are preserved; missing fields get defaults.

### 5. Dual Drag-and-Drop

- **Tauri native** `onDragDropEvent` for the production Tauri webview (provides full file paths).
- **HTML5 DnD** fallback for browser dev mode (uses `dataTransfer.files`).
- Shared `hitTestDropzone()` and `filterPaths()` utilities.

### 6. Hardware Detection & Encoder Selection

- On mount, `useHardware` invokes `detect_hardware` to get CPU/GPU/RAM/AV1 support.
- `resolveEncoder(codec)` maps codec → FFmpeg encoder name based on GPU vendor (NVENC, AMF, QSV, or software).
- If AV1 is selected but unsupported by hardware, auto-falls-back to H.265.

---

## Scripts

| Script                  | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `bun dev` / `bun start` | Start Vite dev server                                            |
| `bun build`             | Production build                                                 |
| `bun tauri dev`         | Tauri dev mode (desktop window)                                  |
| `bun tauri build`       | Production desktop build                                         |
| `bun test`              | Run all vitest tests                                             |
| `bun lint`              | Run oxlint                                                       |
| `bun lint:fix`          | Run oxlint with auto-fix                                         |
| `bun format`            | Run oxfmt (formats staged `.ts`, `.tsx`, `.css`, `.json`, `.md`) |
| `bun format:check`      | Check formatting (CI)                                            |
| `bun prepare`           | Initialize Husky hooks (auto-run after `bun install`)            |

---

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.x+
- [FFmpeg](https://ffmpeg.org/) + `ffprobe` in PATH
- [Rust](https://www.rust-lang.org/) toolchain (for Tauri builds)

### Quick Start

```bash
git clone <repo-url>
cd ubet-render
bun install
bun tauri dev       # Desktop app with hot-reload
```

For frontend-only development (no Tauri window):

```bash
bun dev             # Opens http://localhost:1420 in browser
```

> **Note:** Tauri IPC and native APIs are mocked in test mode but unavailable in browser dev. UI components render normally; backend operations (`detect_hardware`, `start_render`, etc.) will log errors.

---

## Testing

The project has a comprehensive test suite spanning both Vitest (frontend) and
`cargo test` (backend), covering:

- **Core utilities**: Config defaults, bitrate validation, ETA formatting, localStorage persistence
- **Hooks**: Config persistence, hardware detection, pipeline lifecycle
- **Components**: Every component tested in isolation (rendered states, event handlers, edge cases)
- **Rust backend**: Encoder mappings, path-traversal hardening, validation, audio pool lifecycle
- **Integration**: Full render lifecycle with mocked Tauri IPC

To get an exact test count after a fresh checkout, run `bun test` — vitest
prints it on exit. The README intentionally avoids hard-coding the number so
it does not drift as soon as a new test is added.

```bash
bun run test             # Run all tests (≈95 tests, Vitest + jsdom)
bun run test --watch     # Watch mode
bun run test src/core/persisted.test.ts  # Single file
```

> **Important:** Use `bun run test` (which executes the `vitest run` script
> in `package.json`), **not** the bare `bun test`. The latter activates
> Bun's built-in test runner (a different API surface — `describe`/`it`/
> `vi.mock`/jsdom polyfills) and produces confusing errors like
> `ReferenceError: document is not defined`.

---

## Project Status

**Version:** 0.3.0 • **License:** MIT

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

---

_Built with ❤️ using SolidJS, Tauri, Rust, and a lot of FFmpeg CLI incantations._
