# Ubet Render

My personal offline-first engine to automate video-looping & audio playlist muxing. Built because manually stretching timelines, setting up ping-pong loops, and compiling tracklists in Premiere/FFmpeg CLI for hours was driving me insane.

It behaves like a modern SaaS dashboard but runs entirely local on your machine. No web uploads, no cloud rendering fees, and no external trackers. Just raw, hardware-accelerated processing powered by Rust & FFmpeg.

---

## The Problem

Making long-form looped videos (like 1-hour lo-fi mixes, stream screens, or ambient soundscapes) usually requires two painful steps:
1. Exporting a perfectly looped video (often requiring mirroring the video backward so the cut isn't jarring).
2. Stretching that loop to fit a compilation of audio tracks, then manually writing down timestamps for YouTube.

Ubet Render does both in one click. You feed it a video, point it to your audio folder, specify a target duration, and it compiles the final output using stream-copying (meaning no redundant rendering overhead after the initial loop template is prepared).

---

## Inside the Dashboard

- **Ping-Pong Mirroring**: Seamlessly mirrors short clips (A -> B -> A) and applies Lanczos upscaling with subtle unsharp masking for a clean look.
- **Zero-Reencode Muxing**: Once the base video loop is encoded, the final compilation is built by stream-copying both audio and video tracks directly. It takes seconds rather than hours to generate the final file.
- **Smart Playlists**: Shuffles and gathers audio tracks up to your target duration (e.g. 1 hour, 10 hours), and handles the math.
- **Auto-Generated Timestamps**: Produces a clean text file of YouTube-compliant timestamps (starting at `00:00` or `00:00:00` depending on duration) so you can copy-paste them directly into your video descriptions.
- **Hardware-Aware**: Dynamically queries your system's hardware configuration at startup to auto-select NVIDIA NVENC, AMD AMF, or Intel QSV hardware acceleration, falling back to software SVT-AV1 or CPU encoders when GPUs aren't present.

---

## Stack

- **Frontend**: SolidJS + TailwindCSS v4 + DaisyUI (for a lightweight, highly responsive control panel)
- **Runtime**: Bun (for package management and lightning-fast developer experience)
- **Desktop Wrapper**: Tauri v2 (providing the OS integration and Rust bridge)
- **Core Engine**: Rust (orchestrating tokio asynchronous streams and background FFmpeg wrappers)

---

## Setup & Run

### Prerequisites

You need `ffmpeg` and `ffprobe` installed and accessible in your system's environment variables (PATH).

### Dev Mode

```bash
bun install
bun tauri dev
```

### Production Build

```bash
bun tauri build
```
