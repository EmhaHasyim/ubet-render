# Media Extensions — Single Source of Truth

The render pipeline accepts (and only accepts) the file extensions listed in
this document. **Both the SolidJS frontend and the Rust backend must agree on
this list.** Any new format added here must be mirrored in:

| Layer          | File                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend (TS)  | [`src/core/config.ts`](../src/core/config.ts) — `VIDEO_EXTENSIONS` / `AUDIO_EXTENSIONS`                                                 |
| Backend (Rust) | [`src-tauri/src/validation.rs`](../src-tauri/src/validation.rs) — `VALID_ENCODERS_FFMPEG_*` justification, plus `pipeline/estimator.rs` |
| Backend (scan) | [`src-tauri/src/pipeline/source_scanner.rs`](../src-tauri/src/pipeline/source_scanner.rs) — directory walker                            |

The Rust and TS drift-detection tests (`config.test.ts` and
`validation::tests`) **do not parse this markdown file**. They each maintain
a hardcoded `EXPECTED_*` sentinel list (the machine-enforced mirror of the
contract below) and assert that the implementation constants equal the
sentinel. If you add a row here but forget to update any of the following,
**that side fails CI**:

1. `docs/MEDIA_EXTENSIONS.md` (this file — human contract)
2. `src/core/config.ts` (TypeScript implementation + `EXPECTED_*` sentinel
   inside `src/core/config.test.ts`)
3. `src-tauri/src/pipeline/estimator.rs` (Rust implementation + `EXPECTED_*`
   sentinel inside `src-tauri/src/validation.rs::tests`)

---

## Video

`.mp4`, `.mkv`, `.mov`, `.webm`, `.avi`, `.flv`, `.wmv`

> **Notes**
>
> - `.webm` is supportable via `libvpx-vp9` or `libaom-av1` wrapper codecs,
>   but muxing to MP4 with a non-AVC stream requires the source to match the
>   target encoder (see `skip_reencode_when_aliases_match` test).
> - `.avi` and `.flv` exist for legacy compatibility; their
>   `video_codec_name` field returned by `ffprobe` is unreliable and may
>   trigger a forced re-encode even when visually compatible.
> - `.wmv` uses Microsoft codecs not commonly shipping in FFmpeg; treat as
>   best-effort.

## Audio

`.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.aac`, `.wma`

> **Notes**
>
> - `.flac` is preferred over `.wav` for lossless sources — smaller files,
>   same trust profile.
> - `.ogg` is typically Vorbis or Opus; both are supported.
> - `.wma` is Microsoft Windows Media Audio; treat as best-effort.

---

## How to add a new format

1. Add the extension to the **matching list above** in this file. Use a
   lowercase, leading-dot form.
2. Update `VIDEO_EXTENSIONS` / `AUDIO_EXTENSIONS` in
   [`src/core/config.ts`](../src/core/config.ts).
3. Mirror the change in
   [`src-tauri/src/validation.rs`](../src-tauri/src/validation.rs) (look for
   the `VIDEO_EXTENSIONS` / `AUDIO_EXTENSIONS` near the encoder allow-list)
   and / or the `estimator` module used by `source_scanner`.
4. Run `bun test src/core/config.test.ts` and
   `cargo test --manifest-path src-tauri/Cargo.toml` — both must pass
   before you push.

If the test drifts and the source lists stop matching this document, **fix
the test data, not the source constants** — the constants are the
implementation; this file is the contract.
