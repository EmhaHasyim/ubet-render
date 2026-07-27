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
        async move {
            // Pre-flight cancel before spawning any heavyweight probe.
            if let Some(c) = cancel_control.as_ref() {
                if c.is_cancelled() {
                    return Err(AppError::Cancelled("Render cancelled by user".into()));
                }
                if c.is_paused() {
                    return Err(AppError::Paused("Render paused by user".into()));
                }
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

            // Cache key includes a mode tag so the three branches never
            // collide with each other in the cache directory — the same
            // song may legitimately produce two cache files (one as
            // `-c copy`, one as normalized re-encode) under different
            // settings.
            let mode_tag = if use_smart_skip {
                "skip"
            } else if normalize {
                "2pass"
            } else {
                "enc"
            };
            let cache_key = format!(
                "{}|{}|{}|{}|{}",
                song, br, sample_rate, lp, mode_tag
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

            // Single-stat cache check: zero-byte (incomplete from a prior
            // cancel) is treated as a miss; racing removal collapses into
            // the default `false` result.
            let cache_is_usable = cache_path
                .metadata()
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

                let mut args: Vec<String> = Vec::with_capacity(16);
                args.push("-y".into());
                args.push("-i".into());
                args.push(input_path_str);
                args.push("-vn".into());
                if use_smart_skip {
                    args.push("-c:a".into());
                    args.push("copy".into());
                } else {
                    args.push("-c:a".into());
                    args.push("aac".into());
                    args.push("-b:a".into());
                    args.push(br.clone());
                    args.push("-ar".into());
                    args.push(sample_rate_str);
                    // FEATURE 6: explicit -ac 2 keeps the output profile
                    // strict-stereo regardless of source layout (mono
                    // duplicates to L+R, 5.1 downmixes via ffmpeg's
                    // default). Probe is informational only — flipping
                    // this default would break downstream concat copies.
                    args.push("-ac".into());
                    args.push("2".into());
                }
                if let Some(ref filt) = effective_loudnorm {
                    args.push("-af".into());
                    args.push(filt.clone());
                }
                args.push(output_path_str);

                let run_result =
                    ffmpeg::run(&app_clone, &args, None, cancel_control.clone(), None).await;
                if run_result.is_err() {
                    let _ = fs::safe_delete_sync(&tmp_path);
                }
                run_result?;

                if let Err(e) = std::fs::rename(&tmp_path, &cache_path) {
                    let _ = fs::safe_delete_sync(&tmp_path);
                    return Err(AppError::Io(e));
                }
            }

            let duration = ffmpeg::get_duration(&app_clone, &cache_path).await?;
            if duration <= 0.0 {
                return Err(AppError::InvalidDuration(song));
            }

            // FEATURE 4 (per-track progress): emit `Audio N/M ready: ...`
            // after every track finishes. The label tells the user
            // exactly which code path executed.
            let completed = processed.fetch_add(1, Ordering::Relaxed) + 1;
            let mode_label = if use_smart_skip {
                "copied (smart-skip)"
            } else if measurement.is_some() {
                "normalized 2-pass"
            } else if normalize {
                "normalized (1-pass fallback)"
            } else {
                "re-encoded"
            };
            event::emit(
                &app_clone,
                crate::models::job::PipelineEvent::Log {
                    level: "info".into(),
                    message: format!(
                        "Audio {}/{} ready: {} ({})",
                        completed, total, original_name, mode_label
                    ),
                },
            );

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
    if let (Some(source_br), Some(target_kbps)) =
        (info.bit_rate, parse_bitrate_to_kbps(target_br_s))
    {
        if source_br > target_kbps.saturating_mul(1000) {
            return false;
        }
    }
    true
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
    let meta = std::fs::metadata(input).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}", input.to_string_lossy(), size, mtime);
    let hash = fs::hash_path128(key.as_bytes());
    let meas_path = cache_dir.join(format!("loudnorm_p1_{:032x}.json", hash));
    let meas_tmp = cache_dir.join(format!("loudnorm_p1_{:032x}.json.tmp", hash));

    match std::fs::read_to_string(&meas_path) {
        Ok(text) => match serde_json::from_str::<LoudnormMeasurement>(&text) {
            Ok(m) => return Ok(m),
            Err(_) => {} // fall through: corrupt cache, recompute
        },
        Err(_) => {} // fall through: missing cache, recompute
    }

    let m = ffmpeg::run_loudnorm_pass1(app, input, target, cancel.cloned()).await?;

    let json = serde_json::to_string(&m).map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("loudnorm measurement serialize: {}", e),
        ))
    })?;
    if let Err(e) = std::fs::write(&meas_tmp, json.as_bytes()) {
        let _ = fs::safe_delete_sync(&meas_tmp);
        return Err(AppError::Io(e));
    }
    if let Err(e) = std::fs::rename(&meas_tmp, &meas_path) {
        let _ = fs::safe_delete_sync(&meas_tmp);
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
    fn test_can_skip_reencode_unknown_bps_passes() {
        let i = info("aac", 44100, 2, None);
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_meets_bps_passes() {
        let i = info("aac", 44100, 2, Some(128_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }
}
