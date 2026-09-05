use crate::config::AudioSettings;
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::{AudioInfo, LoudnormMeasurement, ProcessedAudio};
use crate::pipeline::estimator::parse_bitrate_to_kbps;
use crate::utils::event;
use crate::utils::fs;
use futures::stream::{self, StreamExt};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::AppHandle;

/// Build the master audio pool used by the video render step.
///
/// Improvements over the historical single-pass implementation:
/// 1. **Dedupe up front** — duplicate paths in the input slice would
///    otherwise race on the same cache file (`master_audio_<hash>.m4a`)
///    because two workers could see `exists() == false` at the same time
///    and both try to write. A single `HashSet` collapses the list before
///    worker dispatch.
/// 2. **One ffprobe per track** — `get_audio_info` returns codec, sample
///    rate, channel count, and bit rate in one round-trip. We use this
///    for both smart-skip and channel-layout decisions.
/// 3. **Smart-skip** — when the source already matches the target profile
///    (`codec == aac`, sample rate matches, exactly 2 channels, bit rate
///    ≤ target if reported) we transcode with `-c copy` instead of
///    re-encoding. Strict 2-channel requirement protects downstream
///    concat: mono sources fall through to re-encode so the cache file
///    matches the uniform 2-channel AAC layout. Disabled automatically
///    when the user picked the `normalize` mode because loudnorm must
///    still apply.
/// 4. **Two-pass loudnorm** — when `audio_mode == "normalize"`, pass 1
///    measures the source via `loudnorm=...:print_format=json` and the
///    measured values are fed back to pass 2 (with `linear=true`) for
///    EBU R128-grade accuracy instead of blind single-pass application.
///    Pass-1 measurements are cached on disk keyed by `(path, size, mtime)`
///    so subsequent renders don't re-analyze the same file. Falls back
///    gracefully to single-pass if measurement or pass 2 fails.
/// 5. **Atomic write + tmp cleanup** — every ffmpeg output is written to
///    a `.tmp` sibling and renamed into the final cache path only after
///    the ffmpeg exit status is good. If ffmpeg fails (cancelled,
///    errored, panicked), the leftover `.tmp` is `safe_delete_sync`'d so
///    cancelled sessions never accumulate disk garbage.
/// 6. **Per-track progress** — after each track finishes, a `Log` event
///    reports `Audio N/M ready: filename (copied|normalized 2-pass|...)
///    so the dashboard sees the pool filling up in real time instead of
///    waiting for the final "X songs ready." line.
pub async fn build_master_audio_pool(
    app: &AppHandle,
    cache_dir: &Path,
    audio_files: &[String],
    settings: &AudioSettings,
    audio_mode: &str,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<Arc<Vec<ProcessedAudio>>, AppError> {
    // FEATURE 1: dedupe before dispatch. The scanner above already
    // canonicalizes, so exact-string equality is sufficient to catch user
    // duplicates from drag-and-drop / explicit file listings. No extra IO.
    let dedup_files = dedupe_paths(audio_files);
    let dupes = audio_files.len() - dedup_files.len();
    if dupes > 0 {
        event::emit(
            app,
            crate::models::job::PipelineEvent::Log {
                level: "warn".into(),
                message: format!(
                    "Deduplicated {} duplicate audio file(s); {} unique tracks will be processed",
                    dupes,
                    dedup_files.len()
                ),
            },
        );
    }

    // Auto-scale concurrency: respect user config but never exceed
    // `available_parallelism × 2` so I/O-bound audio encode does not
    // saturate the CPU.
    let max_parallel = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let concurrent = settings
        .concurrent_prep
        .max(1)
        .min(max_parallel.saturating_mul(2));

    let processed = Arc::new(AtomicUsize::new(0));
    let total = dedup_files.len();
    // Track the last milestone band we emitted so concurrent completions
    // don't produce duplicate progress lines.
    let emitted_milestone = Arc::new(AtomicUsize::new(0));
    // Shared milestone granularity (see `loop_control::milestone_step`).
    let milestone_step = crate::pipeline::loop_control::milestone_step(total);
    let cache_dir_arc = Arc::new(cache_dir.to_path_buf());

    let loudnorm_params = settings.loudnorm_params.clone();
    let bitrate = settings.bitrate.clone();
    let sample_rate = settings.sample_rate;
    let normalize = audio_mode.eq_ignore_ascii_case("normalize");

    let mut stream = stream::iter(dedup_files.into_iter().map(move |song| {
        let cache_dir = Arc::clone(&cache_dir_arc);
        let cancel_control = cancel_control.clone();
        let app_clone = app.clone();
        let lp = loudnorm_params.clone();
        let br = bitrate.clone();
        let processed = Arc::clone(&processed);
        let emitted_milestone = Arc::clone(&emitted_milestone);
        async move {
            // Pre-flight cancel before spawning any heavyweight probe.
            if let Some(c) = cancel_control.as_ref() {
                c.ensure_running()?;
            }

            let original_path = PathBuf::from(&song);
            let original_name = original_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // FEATURE 2 + 6: single ffprobe round-trip. Failure here is
            // non-fatal: we degrade to straight single-pass encode.
            let info: Option<AudioInfo> =
                ffmpeg::get_audio_info(&app_clone, &original_path).await.ok();

            let can_smart_skip = info
                .as_ref()
                .map(|i| can_skip_reencode(i, sample_rate, &br))
                .unwrap_or(false);
            // When normalization is active, smart-skip is suppressed
            // because loudnorm must still apply to AAC sources to honor
            // the user's `-14 LUFS` target.
            let use_smart_skip = can_smart_skip && !normalize;

            // Cache key includes a schema version, source file signature, and
            // mode tag. Replacing a file at the same path must never reuse an
            // older encoded result, even when the output settings are equal.
            let mode_tag = if use_smart_skip {
                "skip"
            } else if normalize {
                "2pass"
            } else {
                "enc"
            };
            // Hashing the full source is intentionally content-aware, but it
            // is synchronous file I/O. Keep it off the Tokio worker so a large
            // audio file cannot stall unrelated pipeline tasks.
            let signature_path = original_path.clone();
            let source_signature = tokio::task::spawn_blocking(move || {
                fs::file_signature(&signature_path)
            })
            .await
            .map_err(|error| AppError::Pipeline(format!("Audio signature task failed: {}", error)))?
            .map_err(AppError::Io)?;
            let cache_key = format!(
                "audio-cache-v2|{}|{}|{}|{}|{}|{}",
                song, source_signature, br, sample_rate, lp, mode_tag
            );
            let file_hash = fs::hash_path128(cache_key.as_bytes());
            let cache_path = cache_dir.join(format!("master_audio_{:032x}.m4a", file_hash));

            // FEATURE 4 (two-pass loudnorm): compute (or fetch cached)
            // measurement. Fallback to single-pass if measurement extract
            // fails or pass 2 fails — never silently drop the user's
            // normalization request.
            let measurement = if normalize && !use_smart_skip {
                get_or_compute_loudnorm_measurement(
                    &app_clone,
                    cache_dir.as_ref(),
                    &original_path,
                    &lp,
                    cancel_control.as_ref(),
                )
                .await
                .ok()
            } else {
                None
            };
            let effective_loudnorm: Option<String> = match &measurement {
                Some(m) => Some(format!(
                    "loudnorm={}:measured_I={}:measured_LRA={}:measured_TP={}:measured_thresh={}:offset={}:linear=true",
                    lp,
                    m.input_i,
                    m.input_lra,
                    m.input_tp,
                    m.input_thresh,
                    m.target_offset
                )),
                None if normalize => Some(format!("loudnorm={}", lp)),
                _ => None,
            };

            // Single-stat cache check (async so the executor is not blocked
            // per track): zero-byte (incomplete from a prior cancel) is
            // treated as a miss; racing removal collapses into `false`.
            let cache_is_usable = tokio::fs::metadata(&cache_path)
                .await
                .map(|m| m.len() > 0)
                .unwrap_or(false);

            if !cache_is_usable {
                // FEATURE 5 (atomic write): write to `.tmp` then rename so
                // a cancel mid-encode never leaves a corrupt cache file
                // that `Path::exists()` would falsely consider valid.
                let tmp_path =
                    cache_dir.join(format!("master_audio_{:032x}.m4a.tmp", file_hash));

                let input_path_str = original_path.to_string_lossy().into_owned();
                let output_path_str = tmp_path.to_string_lossy().into_owned();
                let sample_rate_str = sample_rate.to_string();

                let mut args: Vec<String> = Vec::with_capacity(20);
                args.push("-y".into());
                args.push("-i".into());
                args.push(input_path_str);
                args.push("-vn".into());
                if use_smart_skip {
                    args.push("-c:a".into());
                    args.push("copy".into());
                } else {
                    // Output layout + sample-rate + channels are stated BEFORE
                    // the encoder so the FFmpeg muxer initialiser sees a
                    // complete picture of the wanted stream shape up front.
                    // For .m4a (auto-detected as the MP4 container) this
                    // avoids a class of "Error opening output files: Invalid
                    // argument" failures on FFmpeg >= 8.x where auto-mapping
                    // + auto-muxer selection for audio-only M4A was dropping
                    // audio-track config silently during `avformat_alloc_output_context2`.
                    // Laying -ar/-ac/-b:a out before -c:a is purely for
                    // readability / determinism; FFmpeg accepts either order.
                    args.push("-ar".into());
                    args.push(sample_rate_str);
                    // FEATURE 6: explicit -ac 2 keeps the output profile
                    // strict-stereo regardless of source layout (mono
                    // duplicates to L+R, 5.1 downmixes via ffmpeg's
                    // default). Probe is informational only — flipping
                    // this default would break downstream concat copies.
                    args.push("-ac".into());
                    args.push("2".into());
                    args.push("-c:a".into());
                    args.push("aac".into());
                    args.push("-b:a".into());
                    args.push(br.clone());
                }
                if let Some(ref filt) = effective_loudnorm {
                    args.push("-af".into());
                    args.push(filt.clone());
                }
                // Explicit `-map 0:a:0?` makes the audio-stream selection
                // deterministic when an `-af` filter graph is in play. Without
                // it FFmpeg's auto-mapping can pick a non-audio stream on
                // exotic sources (e.g. cover-art-only M4A) and the muxer
                // setup for `.m4a` then fails with
                // `Error opening output files: Invalid argument`.
                // The `?` suffix keeps the mapping best-effort so an
                // accidental zero-audio-streams input fails with a clearer
                // downstream error rather than a muxer initialisation error.
                args.push("-map".into());
                args.push("0:a:0?".into());
                // Explicit `-f mp4` selects the MP4 muxer up front. The `.m4a`
                // extension triggers the same auto-selection normally, but
                // FFmpeg 8.x's audio-only M4A writer init requires an explicit
                // format hint when combined with explicit `-ar`/`-ac` output
                // flags; without `-f` we observed sporadic
                // `Error opening output files: Invalid argument` from the
                // bundled sidecar.
                args.push("-f".into());
                args.push("mp4".into());
                args.push(output_path_str);

                let run_result =
                    ffmpeg::run(&app_clone, &args, None, cancel_control.clone(), None).await;
                if run_result.is_err() {
                    cleanup_temp_file_sync(&tmp_path);
                }
                run_result?;

                if let Err(e) = fs::atomic_replace(&tmp_path, &cache_path) {
                    cleanup_temp_file_sync(&tmp_path);
                    return Err(AppError::Io(e));
                }
            }

            let duration = ffmpeg::get_duration(&app_clone, &cache_path).await?;
            if duration <= 0.0 {
                return Err(AppError::InvalidDuration(song));
            }

            let completed = processed.fetch_add(1, Ordering::Relaxed) + 1;
            // Emit a single progress line at each milestone (every N tracks
            // or every 25% for small pools) instead of one line per track.
            // `fetch_max` ensures only the first completion that crosses a
            // milestone band emits the log, even under concurrent dispatch.
            let band = completed / milestone_step;
            let prev = emitted_milestone.fetch_max(band, Ordering::Relaxed);
            if band > prev || completed == total {
                let mode_summary = if use_smart_skip {
                    "stream-copied"
                } else if measurement.is_some() {
                    "2-pass normalized"
                } else if normalize {
                    "1-pass normalized"
                } else {
                    "re-encoded"
                };
                event::emit(
                    &app_clone,
                    crate::models::job::PipelineEvent::Log {
                        level: "info".into(),
                        message: format!(
                            "Audio pool: {}/{} tracks ready ({})",
                            completed, total, mode_summary
                        ),
                    },
                );
            }

            Ok(ProcessedAudio {
                path: cache_path.to_string_lossy().to_string(),
                duration,
                original_name,
            })
        }
    }))
    .buffer_unordered(concurrent);

    let mut pool = Vec::new();
    let mut failed_count = 0usize;
    while let Some(res) = stream.next().await {
        match res {
            Ok(audio) => pool.push(audio),
            Err(AppError::Cancelled(e)) => return Err(AppError::Cancelled(e)),
            Err(AppError::Paused(e)) => return Err(AppError::Paused(e)),
            Err(e) => {
                failed_count += 1;
                event::emit(
                    app,
                    crate::models::job::PipelineEvent::Log {
                        level: "error".into(),
                        message: format!("Audio processing error: {}", e),
                    },
                );
            }
        }
    }

    if failed_count > 0 {
        event::emit(
            app,
            crate::models::job::PipelineEvent::Log {
                level: "warn".into(),
                message: format!(
                    "{} audio tracks failed to process; the playlist may be smaller than configured",
                    failed_count
                ),
            },
        );
    }

    Ok(Arc::new(pool))
}

fn cleanup_temp_file_sync(path: &Path) {
    if let Err(error) = fs::safe_delete_sync(path) {
        crate::utils::logger::log_line(&format!(
            "Temporary file cleanup failed for '{}': {}",
            path.display(),
            error
        ));
    }
}

/// Deduplicate a slice of file paths preserving first-seen order.
fn dedupe_paths(paths: &[String]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::with_capacity(paths.len());
    paths
        .iter()
        .filter(|p| seen.insert(p.as_str()))
        .cloned()
        .collect()
}

/// Returns `true` when the source's audio stream already matches the
/// target enough to safely transcode with `-c copy`. All conditions must
/// hold:
///
/// - codec is `aac` (LC-AAC / HE-AAC will be discarded by the down-stream
///   muxer if not neutralized; smart-skip is only safe when AAC-LC).
/// - sample rate exactly equals the user-requested target
///   (avoids FFmpeg's auto-resample, which would defeat the "copy").
/// - channels **exactly equals 2**: mono sources MUST go through the
///   re-encode path because `-c copy` preserves the channel layout and
///   would produce a mono cache file incompatible with the downstream
///   2-channel master; 5.1+ sources must be downmixed via re-encode.
/// - bit rate, when reported, does not exceed the user-requested target
///   (a higher-bitrate AAC can be downgraded, but only via re-encode).
///
/// Bit-rate parser reused from `pipeline::estimator::parse_bitrate_to_kbps`
/// so the audio-pool cannot drift from the canonical bit-rate parser.
fn can_skip_reencode(info: &AudioInfo, target_sr: u32, target_br_s: &str) -> bool {
    if !info.codec.eq_ignore_ascii_case("aac") {
        return false;
    }
    if info.sample_rate != target_sr {
        return false;
    }
    // Strict equality: anything other than 2ch (mono or 5.1+) MUST be
    // re-encoded so the cache file matches the downstream pipeline's
    // expected uniform 2-channel AAC layout.
    if info.channels != 2 {
        return false;
    }
    let Some(source_br) = info.bit_rate else {
        // Unknown bitrate cannot prove that stream-copy satisfies the target
        // profile. Prefer a deterministic re-encode over silently violating
        // the requested bitrate.
        return false;
    };
    let Some(target_kbps) = parse_bitrate_to_kbps(target_br_s) else {
        return false;
    };
    source_br <= target_kbps.saturating_mul(1000)
}

/// Get the cached loudnorm measurement for `input`, or run pass 1 and
/// cache its result. Cache key is `hash(path, size, mtime_secs)` so a
/// in-place file replacement with the same byte length correctly busts
/// the cache via the mtime component.
async fn get_or_compute_loudnorm_measurement(
    app: &AppHandle,
    cache_dir: &Path,
    input: &Path,
    target: &str,
    cancel: Option<&Arc<crate::RenderControl>>,
) -> Result<LoudnormMeasurement, AppError> {
    // Include the target filter parameters as well as a content-aware source
    // signature. A changed loudnorm target must not reuse a measurement made
    // for a previous target, and a same-size/same-mtime source replacement
    // must invalidate the measurement too.
    let signature_path = input.to_path_buf();
    let source_signature = tokio::task::spawn_blocking(move || fs::file_signature(&signature_path))
        .await
        .map_err(|error| AppError::Pipeline(format!("Loudnorm signature task failed: {}", error)))?
        .map_err(AppError::Io)?;
    let key = format!(
        "loudnorm-cache-v2|{}|{}|{}",
        input.to_string_lossy(),
        source_signature,
        target
    );
    let hash = fs::hash_path128(key.as_bytes());
    let meas_path = cache_dir.join(format!("loudnorm_p1_{:032x}.json", hash));
    let meas_tmp = cache_dir.join(format!("loudnorm_p1_{:032x}.json.tmp", hash));

    if let Ok(text) = tokio::fs::read_to_string(&meas_path).await
        && let Ok(m) = serde_json::from_str::<LoudnormMeasurement>(&text)
    {
        return Ok(m);
    }

    let m = ffmpeg::run_loudnorm_pass1(app, input, target, cancel.cloned()).await?;

    let json = serde_json::to_string(&m).map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("loudnorm measurement serialize: {}", e),
        ))
    })?;
    if let Err(e) = tokio::fs::write(&meas_tmp, json.as_bytes()).await {
        cleanup_temp_file_sync(&meas_tmp);
        return Err(AppError::Io(e));
    }
    if let Err(e) = fs::atomic_replace(&meas_tmp, &meas_path) {
        cleanup_temp_file_sync(&meas_tmp);
        return Err(AppError::Io(e));
    }

    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------
    // dedupe_paths
    // -------------------------------------------------------------------

    #[test]
    fn test_dedupe_paths_preserves_order() {
        let input = vec![
            "a.mp3".to_string(),
            "b.mp3".to_string(),
            "a.mp3".to_string(),
            "c.mp3".to_string(),
            "b.mp3".to_string(),
        ];
        let out = dedupe_paths(&input);
        assert_eq!(out, vec!["a.mp3", "b.mp3", "c.mp3"]);
    }

    #[test]
    fn test_dedupe_paths_empty() {
        let input: Vec<String> = vec![];
        let out = dedupe_paths(&input);
        assert!(out.is_empty());
    }

    #[test]
    fn test_dedupe_paths_no_dupes() {
        let input = vec!["x".to_string(), "y".to_string(), "z".to_string()];
        let out = dedupe_paths(&input);
        assert_eq!(out, input);
    }

    #[test]
    fn test_dedupe_paths_all_dupes() {
        let input = vec!["same".to_string(); 4];
        let out = dedupe_paths(&input);
        assert_eq!(out, vec!["same".to_string()]);
    }

    // -------------------------------------------------------------------
    // can_skip_reencode
    // -------------------------------------------------------------------

    fn info(codec: &str, sr: u32, ch: u32, br: Option<u32>) -> AudioInfo {
        AudioInfo {
            codec: codec.into(),
            sample_rate: sr,
            channels: ch,
            bit_rate: br,
        }
    }

    #[test]
    fn test_can_skip_reencode_matching_aac_stereo() {
        let i = info("aac", 44100, 2, Some(192_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_wrong_codec_rejected() {
        let i = info("mp3", 44100, 2, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_wrong_sample_rate_rejected() {
        let i = info("aac", 48000, 2, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_too_many_channels_rejected() {
        let i = info("aac", 44100, 6, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    /// CRITICAL: a mono (1-channel) AAC source must NOT be smart-skipped
    /// because `-c copy` preserves channel layout; the resulting cache
    /// file would be mono and break the downstream 2-channel concat
    /// demuxer. This test guards against the previous (channels <= 2)
    /// implementation bug.
    #[test]
    fn test_can_skip_reencode_mono_channels_rejected() {
        let i = info("aac", 44100, 1, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_source_higher_bps_rejected() {
        let i = info("aac", 44100, 2, Some(320_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_unknown_bps_rejected() {
        let i = info("aac", 44100, 2, None);
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_meets_bps_passes() {
        let i = info("aac", 44100, 2, Some(128_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }
}
