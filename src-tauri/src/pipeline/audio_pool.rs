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

/// Per-track worker context. Cloned cheaply per item (all heavy fields are
/// `Arc`s or clonable handles) so the track pipeline can be read on its own.
#[derive(Clone)]
struct TrackProcessor {
    app: AppHandle,
    cache_dir: Arc<PathBuf>,
    cancel_control: Option<Arc<crate::RenderControl>>,
    loudnorm_params: String,
    bitrate: String,
    sample_rate: u32,
    normalize: bool,
    processed: Arc<AtomicUsize>,
    emitted_max: Arc<AtomicUsize>,
    total: usize,
}

impl TrackProcessor {
    async fn process(&self, song: String) -> Result<ProcessedAudio, AppError> {
        // Pre-flight cancel before spawning any heavyweight probe.
        if let Some(c) = self.cancel_control.as_ref() {
            c.ensure_running()?;
        }

        let original_path = PathBuf::from(&song);
        let original_name = original_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Single ffprobe round-trip. Failure here is non-fatal: we degrade to
        // a straight single-pass encode.
        let info = ffmpeg::get_audio_info(&self.app, &original_path).await.ok();
        let can_smart_skip = info
            .as_ref()
            .is_some_and(|i| can_skip_reencode(i, self.sample_rate, &self.bitrate));
        // Loudnorm must still apply to AAC sources in normalize mode.
        let use_smart_skip = can_smart_skip && !self.normalize;

        let mode_tag = if use_smart_skip {
            "skip"
        } else if self.normalize {
            "2pass"
        } else {
            "enc"
        };
        // Signature sampling is synchronous file I/O; keep it off the runtime.
        let signature_path = original_path.clone();
        let source_signature =
            tokio::task::spawn_blocking(move || fs::file_signature(&signature_path))
                .await
                .map_err(|error| {
                    AppError::Pipeline(format!("Audio signature task failed: {error}"))
                })?
                .map_err(AppError::Io)?;
        let cache_key = format!(
            "audio-cache-v2|{}|{}|{}|{}|{}|{}",
            song, source_signature, self.bitrate, self.sample_rate, self.loudnorm_params, mode_tag
        );
        let file_hash = fs::hash_path128(cache_key.as_bytes());
        let cache_path = self
            .cache_dir
            .join(format!("master_audio_{file_hash:032x}.m4a"));

        let measurement = if self.normalize && !use_smart_skip {
            get_or_compute_loudnorm_measurement(
                &self.app,
                self.cache_dir.as_ref(),
                &original_path,
                &self.loudnorm_params,
                self.cancel_control.as_ref(),
            )
            .await
            .ok()
        } else {
            None
        };
        let effective_loudnorm =
            loudnorm_filter(measurement.as_ref(), &self.loudnorm_params, self.normalize);

        // A zero-byte cache file is an incomplete prior write, not a hit.
        let cache_is_usable = tokio::fs::metadata(&cache_path)
            .await
            .is_ok_and(|m| m.len() > 0);

        if !cache_is_usable {
            let tmp_path = self
                .cache_dir
                .join(format!("master_audio_{file_hash:032x}.m4a.tmp"));
            let args = build_encode_args(
                &original_path.to_string_lossy(),
                &tmp_path.to_string_lossy(),
                self.sample_rate,
                &self.bitrate,
                use_smart_skip,
                effective_loudnorm.as_deref(),
            );
            let run_result =
                ffmpeg::run(&self.app, &args, None, self.cancel_control.clone(), None).await;
            if run_result.is_err() {
                cleanup_temp_file_sync(&tmp_path);
            }
            run_result?;

            if let Err(e) = fs::atomic_replace_async(&tmp_path, &cache_path).await {
                cleanup_temp_file_sync(&tmp_path);
                return Err(AppError::Io(e));
            }
        }

        let duration = ffmpeg::get_duration(&self.app, &cache_path).await?;
        if duration <= 0.0 {
            return Err(AppError::InvalidDuration(song));
        }

        self.report_progress(use_smart_skip, measurement.is_some());
        Ok(ProcessedAudio {
            path: cache_path.to_string_lossy().to_string(),
            duration,
            original_name,
        })
    }

    fn report_progress(&self, use_smart_skip: bool, measured: bool) {
        let completed = self.processed.fetch_add(1, Ordering::Relaxed) + 1;
        // Completions arrive concurrently; only the highest counter is printed
        // so a late track never emits a lower number.
        let previous = self.emitted_max.fetch_max(completed, Ordering::Relaxed);
        if completed <= previous {
            return;
        }
        let mode_summary = if use_smart_skip {
            "stream-copied"
        } else if measured {
            "2-pass normalized"
        } else if self.normalize {
            "1-pass normalized"
        } else {
            "re-encoded"
        };
        event::emit(
            &self.app,
            crate::models::job::PipelineEvent::Log {
                level: "info".into(),
                message: format!(
                    "Audio pool: {}/{} tracks ready ({})",
                    completed, self.total, mode_summary
                ),
            },
        );
    }
}

/// Build the FFmpeg argument list for one cache file.
fn build_encode_args(
    input_path: &str,
    output_path: &str,
    sample_rate: u32,
    bitrate: &str,
    use_smart_skip: bool,
    loudnorm: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::with_capacity(20);
    args.push("-y".into());
    args.push("-i".into());
    args.push(input_path.into());
    args.push("-vn".into());
    if use_smart_skip {
        args.push("-c:a".into());
        args.push("copy".into());
    } else {
        // Explicit layout + encoder settings. `-ar`/`-ac` before `-c:a` keeps
        // FFmpeg 8.x's audio-only M4A muxer initialisation deterministic.
        args.push("-ar".into());
        args.push(sample_rate.to_string());
        args.push("-ac".into());
        args.push("2".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push(bitrate.into());
    }
    if let Some(filter) = loudnorm {
        args.push("-af".into());
        args.push(filter.into());
    }
    // Deterministic first-audio-stream mapping for exotic containers.
    args.push("-map".into());
    args.push("0:a:0?".into());
    // Explicit MP4 muxer: the `.m4a` extension alone is not reliable with
    // explicit `-ar`/`-ac` on FFmpeg 8.x.
    args.push("-f".into());
    args.push("mp4".into());
    args.push(output_path.into());
    args
}

/// Two-pass loudnorm filter when a measurement is available, one-pass when
/// normalization was requested without one, and no filter otherwise.
fn loudnorm_filter(
    measurement: Option<&LoudnormMeasurement>,
    target: &str,
    normalize: bool,
) -> Option<String> {
    match measurement {
        Some(m) => Some(format!(
            "loudnorm={}:measured_I={}:measured_LRA={}:measured_TP={}:measured_thresh={}:offset={}:linear=true",
            target, m.input_i, m.input_lra, m.input_tp, m.input_thresh, m.target_offset
        )),
        None if normalize => Some(format!("loudnorm={target}")),
        None => None,
    }
}

/// Build the master audio pool used by the video render step.
///
/// Improvements over the historical single-pass implementation:
/// 1. **Dedupe up front** — duplicate paths in the input slice would
///    otherwise race on the same cache file (`master_audio_<hash>.m4a`)
///    because two workers could see `exists() == false` at the same time
///    and both try to write. A single `HashSet` collapses the list before
///    worker dispatch.
/// 2. **One ffprobe per track** — `get_audio_info` returns codec, profile,
///    sample rate, channel count, and bit rate in one round-trip. We use
///    this for both smart-skip and channel-layout decisions.
/// 3. **Smart-skip** — when the source already matches the target profile
///    (`codec == aac` with profile `LC`, sample rate matches, exactly 2
///    channels, bit rate ≤ target if reported) we transcode with
///    `-c copy` instead of re-encoding. The explicit LC check keeps
///    HE-AAC/SBR sources on the re-encode path so the cache file stays
///    uniformly AAC-LC; the strict 2-channel requirement protects
///    downstream concat too (mono sources fall through to re-encode so
///    the cache file matches the uniform 2-channel AAC layout). Disabled
///    automatically when the user picked the `normalize` mode because
///    loudnorm must still apply.
/// 4. **Two-pass loudnorm** — when `audio_mode == "normalize"`, pass 1
///    measures the source via `loudnorm=...:print_format=json` and the
///    measured values are fed back to pass 2 (with `linear=true`) for
///    EBU R128-grade accuracy instead of blind single-pass application.
///    Pass-1 measurements are cached on disk keyed by path, loudnorm target,
///    and a content signature, so subsequent renders don't re-analyze the
///    same file. Falls back
///    gracefully to single-pass if measurement or pass 2 fails.
/// 5. **Atomic write + tmp cleanup** — every ffmpeg output is written to
///    a `.tmp` sibling and renamed into the final cache path only after
///    the ffmpeg exit status is good. If ffmpeg fails (cancelled,
///    errored, panicked), the leftover `.tmp` is `safe_delete_sync`'d so
///    cancelled sessions never accumulate disk garbage.
/// 6. **Per-track progress** — after each track finishes, a `Log` event
///    reports `Audio pool: N/M tracks ready (stream-copied|2-pass normalized|
///    1-pass normalized|re-encoded)`
///    so the dashboard sees the pool filling up in real time instead of
///    waiting for the final summary line.
pub async fn build_master_audio_pool(
    app: &AppHandle,
    cache_dir: &Path,
    audio_files: &[String],
    settings: &AudioSettings,
    audio_mode: &str,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<Arc<Vec<ProcessedAudio>>, AppError> {
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
    let max_parallel = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
    let concurrent = settings
        .concurrent_prep
        .max(1)
        .min(max_parallel.saturating_mul(2));

    let processor = TrackProcessor {
        app: app.clone(),
        cache_dir: Arc::new(cache_dir.to_path_buf()),
        cancel_control,
        loudnorm_params: settings.loudnorm_params.clone(),
        bitrate: settings.bitrate.clone(),
        sample_rate: settings.sample_rate,
        normalize: audio_mode.eq_ignore_ascii_case("normalize"),
        processed: Arc::new(AtomicUsize::new(0)),
        emitted_max: Arc::new(AtomicUsize::new(0)),
        total: dedup_files.len(),
    };

    let mut stream = stream::iter(dedup_files.into_iter().map(move |song| {
        let processor = processor.clone();
        async move { processor.process(song).await }
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
                        message: format!("Audio processing error: {e}"),
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
/// - codec is `aac` **and the reported profile is `LC`**. HE-AAC (SBR/PS)
///   keeps its parameter bands under `-c copy`, so stream-copying it would
///   leave a mixed-profile master that the downstream AAC-LC concat cannot
///   guarantee to mux cleanly. A missing/unparseable profile is treated as
///   not-LC and re-encoded rather than guessed.
/// - sample rate exactly equals the user-requested target
///   (avoids `FFmpeg`'s auto-resample, which would defeat the "copy").
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
    if !info
        .profile
        .as_deref()
        .is_some_and(|profile| profile.eq_ignore_ascii_case("LC"))
    {
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
/// cache its result. The key hashes the path, the loudnorm target, and a
/// content signature, so an in-place replacement invalidates the entry even
/// when its length and modification time are unchanged.
async fn get_or_compute_loudnorm_measurement(
    app: &AppHandle,
    cache_dir: &Path,
    input: &Path,
    target: &str,
    cancel: Option<&Arc<crate::RenderControl>>,
) -> Result<LoudnormMeasurement, AppError> {
    // Include the target filter parameters as well as the source signature.
    // A changed loudnorm target must not reuse a measurement made for a
    // previous target, and a replaced source must not reuse the old one
    // (the signature catches replacements whose size and mtime match).
    let signature_path = input.to_path_buf();
    let source_signature = tokio::task::spawn_blocking(move || fs::file_signature(&signature_path))
        .await
        .map_err(|error| AppError::Pipeline(format!("Loudnorm signature task failed: {error}")))?
        .map_err(AppError::Io)?;
    let key = format!(
        "loudnorm-cache-v2|{}|{}|{}",
        input.to_string_lossy(),
        source_signature,
        target
    );
    let hash = fs::hash_path128(key.as_bytes());
    let meas_path = cache_dir.join(format!("loudnorm_p1_{hash:032x}.json"));
    let meas_tmp = cache_dir.join(format!("loudnorm_p1_{hash:032x}.json.tmp"));

    if let Ok(text) = tokio::fs::read_to_string(&meas_path).await
        && let Ok(m) = serde_json::from_str::<LoudnormMeasurement>(&text)
    {
        return Ok(m);
    }

    let m = ffmpeg::run_loudnorm_pass1(app, input, target, cancel.cloned()).await?;

    let json = serde_json::to_string(&m).map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("loudnorm measurement serialize: {e}"),
        ))
    })?;
    if let Err(e) = tokio::fs::write(&meas_tmp, json.as_bytes()).await {
        cleanup_temp_file_sync(&meas_tmp);
        return Err(AppError::Io(e));
    }
    if let Err(e) = fs::atomic_replace_async(&meas_tmp, &meas_path).await {
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

    /// `profile` is always `Some` here — smart-skip must additionally pass
    /// the LC check, so call sites pass `"LC"` unless a test targets the
    /// profile guard itself.
    fn info(codec: &str, profile: &str, sr: u32, ch: u32, br: Option<u32>) -> AudioInfo {
        AudioInfo {
            codec: codec.into(),
            profile: Some(profile.into()),
            sample_rate: sr,
            channels: ch,
            bit_rate: br,
        }
    }

    #[test]
    fn test_can_skip_reencode_matching_aac_stereo() {
        let i = info("aac", "LC", 44100, 2, Some(192_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_wrong_codec_rejected() {
        let i = info("mp3", "LC", 44100, 2, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_wrong_sample_rate_rejected() {
        let i = info("aac", "LC", 48000, 2, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_too_many_channels_rejected() {
        let i = info("aac", "LC", 44100, 6, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    /// CRITICAL: a mono (1-channel) AAC source must NOT be smart-skipped
    /// because `-c copy` preserves channel layout; the resulting cache
    /// file would be mono and break the downstream 2-channel concat
    /// demuxer. This test guards against the previous (channels <= 2)
    /// implementation bug.
    #[test]
    fn test_can_skip_reencode_mono_channels_rejected() {
        let i = info("aac", "LC", 44100, 1, Some(192_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_source_higher_bps_rejected() {
        let i = info("aac", "LC", 44100, 2, Some(320_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_unknown_bps_rejected() {
        let i = info("aac", "LC", 44100, 2, None);
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_meets_bps_passes() {
        let i = info("aac", "LC", 44100, 2, Some(128_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }

    /// CRITICAL: HE-AAC (SBR/PS) must NOT be smart-skipped. `-c copy`
    /// preserves the profile, and a mixed-profile (HE-AAC alongside AAC-LC)
    /// master is exactly what the LC guard exists to prevent. This test
    /// guards against the previous codec-name-only implementation that
    /// stream-copied any `aac` regardless of profile.
    #[test]
    fn test_can_skip_reencode_he_aac_rejected() {
        let i = info("aac", "HE-AAC", 44100, 2, Some(128_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_he_aac_v2_rejected() {
        let i = info("aac", "HE-AACv2", 44100, 2, Some(128_000));
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    /// A source whose profile ffprobe did not report cannot be proven
    /// AAC-LC — fall through to the deterministic re-encode path.
    #[test]
    fn test_can_skip_reencode_missing_profile_rejected() {
        let i = AudioInfo {
            codec: "aac".into(),
            profile: None,
            sample_rate: 44100,
            channels: 2,
            bit_rate: Some(128_000),
        };
        assert!(!can_skip_reencode(&i, 44100, "192k"));
    }

    #[test]
    fn test_can_skip_reencode_lc_profile_case_insensitive() {
        let i = info("aac", "lc", 44100, 2, Some(128_000));
        assert!(can_skip_reencode(&i, 44100, "192k"));
    }
}
