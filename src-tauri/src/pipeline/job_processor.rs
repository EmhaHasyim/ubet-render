use super::{muxer, state::StateManager, video_loop};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::job::{JobState, PipelineEvent, RenderJob, RenderStats};
use crate::models::media::ProcessedAudio;
use crate::utils::event;
use crate::utils::fs;
use rand::SeedableRng;
use rand::prelude::SliceRandom;
use rand::rngs::{StdRng, SysRng};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

/// Runtime context for a single render job — passed via [`JobContext`] to
/// keep the `process_single_job` parameter list manageable.
pub struct JobContext<'a> {
    pub(crate) index: usize,
    pub(crate) jobs_arc: &'a Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
    pub(crate) cache_dir: &'a Path,
    pub(crate) render_timestamp: u64,
    pub(crate) control: Arc<crate::RenderControl>,
    pub(crate) stats_tx: Option<tokio::sync::mpsc::Sender<RenderStats>>,
}

/// Map BOTH FFmpeg encoder names (e.g. `libsvtav1`) AND the bare / aliased
/// codec names returned by `ffprobe` (e.g. `av1`, `libaom-av1`) to a single
/// canonical token (`h264` / `hevc` / `av1`).  Keeping this mapping
/// symmetrical is what makes the source-vs-target codec comparison in
/// `process_single_job` correctly recognise an AV1 stream from HandBrake or
/// OBS (`libaom-av1`) as AV1 even when the configured encoder is `libsvtav1`
/// or a hardware variant — without this, the smart skip-reencode heuristic
/// would silently fall through to a full encode pass on every codec-match
/// file that happens to use the AOM reference encoder.
fn map_encoder_to_codec(enc: &str) -> &str {
    match enc {
        "h264" | "libx264" | "h264_nvenc" | "h264_amf" | "h264_qsv" => "h264",
        "hevc" | "libx265" | "hevc_nvenc" | "hevc_amf" | "hevc_qsv" => "hevc",
        // Cover NVIDIA / AMD / Intel hardware encoders plus the AOM reference
        // and SVT-AV1 software encoders, including the bare "av1" identifier
        // FFmpeg itself emits. Additional Windows / Linux hardware paths
        // (`av1_mf`, `av1_vaapi`, `av1_v4l2m2m`) are included so a stream
        // produced by any of those still matches on the source side.
        "av1" | "libaom-av1" | "aom" | "svt-av1" | "av1_nvenc" | "av1_amf" | "av1_qsv"
        | "av1_mf" | "av1_vaapi" | "av1_v4l2m2m" | "libsvtav1" => "av1",
        _ => enc,
    }
}

fn requires_intermediate(
    _use_pingpong: bool,
    skip_intermediate_on_codec_match: bool,
    should_reencode: bool,
) -> bool {
    // OFF = always run the intermediate processing step.
    // ON  = skip it when the source can be stream-copied (i.e. re-encode
    //        is not required — either codec matches or the user forced
    //        unconditional skip).
    !skip_intermediate_on_codec_match || should_reencode
}

/// Static configuration for a single render job — extracted into a struct
/// so `process_single_job` doesn't need 15 individual parameters.
pub struct JobParams {
    pub(crate) use_pingpong: bool,
    pub(crate) skip_intermediate_on_codec_match: bool,
    pub(crate) video_cfg: crate::config::VideoSettings,
    pub(crate) encoder_selected: Option<String>,
    pub(crate) master_pool: Arc<Vec<ProcessedAudio>>,
    pub(crate) songs_per_playlist: usize,
    pub(crate) min_duration_sec: u64,
    pub(crate) loop_count: Option<usize>,
    pub(crate) embed_chapters: bool,
}

async fn cleanup_temp_file(path: &Path) {
    if let Err(error) = fs::safe_delete(path).await {
        crate::utils::logger::log_line(&format!(
            "Temporary file cleanup failed for '{}': {}",
            path.display(),
            error
        ));
    }
}

pub(crate) async fn process_single_job(
    app: &AppHandle,
    state_manager: &StateManager,
    padding_sec: u64,
    ctx: JobContext<'_>,
    params: JobParams,
) -> Result<(), AppError> {
    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].state = JobState::Processing;
        lock[ctx.index].current_step = "Preparing".into();
    }
    state_manager
        .emit_progress_from_arc(app, ctx.jobs_arc)
        .await;

    let timestamp = format!("{}_{}", ctx.render_timestamp, ctx.index);
    let (input_path, output_path, name) = {
        let lock = ctx.jobs_arc.lock().await;
        (
            lock[ctx.index].video.input_path.clone(),
            lock[ctx.index].video.output_path.clone(),
            lock[ctx.index].video.name.clone(),
        )
    };

    // Single ffprobe call for duration, codec, and frame rate instead of
    // three separate subprocess invocations (reduces startup overhead per
    // job by ~2× the cost of spawning ffprobe). Fall back to the individual
    // get_duration call if the combined probe fails.
    let (input_codec, input_fps, input_duration) =
        match ffmpeg::get_video_info(app, Path::new(&input_path)).await {
            Ok(info) => (info.codec, info.frame_rate, Ok(info.duration)),
            Err(_) => (
                None,
                30.0,
                ffmpeg::get_duration(app, Path::new(&input_path)).await,
            ),
        };
    let input_duration = input_duration
        .map_err(|_| AppError::Pipeline(format!("Failed to detect video duration: {}", name)))?;

    // When the user opts into skip-intermediate, bypass the codec
    // comparison entirely. The source video is fed directly to the
    // concat demuxer via stream-copy, regardless of whether the source
    // codec matches the target encoder. This is an explicit user choice
    // (the toggle is OFF by default) and the user accepts that the
    // output container/codec is determined solely by the source file.
    let should_reencode = if params.skip_intermediate_on_codec_match {
        false
    } else {
        match (&input_codec, params.encoder_selected.as_deref()) {
            (Some(in_codec), Some(enc)) => {
                // Normalize BOTH sides via the same mapper so codec aliases
                // returned by ffprobe (e.g. `libaom-av1`) compare equal to the
                // encoder name chosen by the frontend (e.g. `libsvtav1`).
                let mapped_enc = map_encoder_to_codec(enc);
                let mapped_in = map_encoder_to_codec(in_codec);
                mapped_in != mapped_enc
            }
            (Some(in_codec), None) => {
                // No encoder override: compare against the configured default encoder
                // to avoid unnecessary re-encoding when source already matches target.
                let mapped_enc = map_encoder_to_codec(params.video_cfg.encoder.as_str());
                let mapped_in = map_encoder_to_codec(in_codec);
                mapped_in != mapped_enc
            }
            _ => true,
        }
    };

    let ping_pong_path;
    let created_intermediate;
    let target_dur = input_duration.max(0.001) * if params.use_pingpong { 2.0 } else { 1.0 };

    // Decide whether the intermediate re-encode (the "1/2 ..." step) is
    // required. When skip_intermediate_on_codec_match is ON, the source
    // is stream-copied unconditionally (should_reencode is forced false).
    // When OFF, the normal codec-matching logic applies.
    let skip_match = params.skip_intermediate_on_codec_match;
    let can_stream_copy = skip_match && !should_reencode;
    let needs_intermediate =
        requires_intermediate(params.use_pingpong, skip_match, should_reencode);

    if can_stream_copy {
        let pingpong_note = if params.use_pingpong {
            " Ping-pong is disabled because stream-copy was explicitly selected."
        } else {
            ""
        };
        event::emit(
            app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!(
                    "Zero-reencode mode ON: skipping intermediate encode and using stream copy.{} Source codec will determine the final output format.",
                    pingpong_note
                ),
            },
        );
    } else if skip_match && should_reencode {
        event::emit(
            app,
            PipelineEvent::Log {
                level: "info".into(),
                message: "Source codec does not match target; keeping the intermediate encode for a compatible output.".into(),
            },
        );
    } else if params.use_pingpong && !should_reencode {
        let canonical = input_codec
            .as_deref()
            .map(map_encoder_to_codec)
            .unwrap_or("unknown");
        event::emit(
            app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!(
                    "Source codec matches target ({}). Applying the ping-pong intermediate.",
                    canonical
                ),
            },
        );
    }

    if needs_intermediate {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = if params.use_pingpong {
                "1/2 Upscaling & ping-pong".into()
            } else {
                "1/2 Re-encoding video".into()
            };
        }
        state_manager
            .emit_progress_from_arc(app, ctx.jobs_arc)
            .await;

        ping_pong_path = ctx
            .cache_dir
            .join(format!("intermediate_{}.mp4", timestamp));
        created_intermediate = true;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);

        let stats_tx_ping = ctx.stats_tx.clone();
        let pingpong = params.use_pingpong;
        let ffmpeg_task = tokio::spawn({
            let input_clone = input_path.clone();
            let ping_pong_path_clone = ping_pong_path.clone();
            let video_cfg_clone = params.video_cfg.clone();
            let control_clone = ctx.control.clone();
            let fps_clone = input_fps;
            let app_clone = app.clone();
            async move {
                video_loop::create_ping_pong_video(video_loop::PingPongVideoParams {
                    app: &app_clone,
                    input: &input_clone,
                    output: &ping_pong_path_clone,
                    video_settings: &video_cfg_clone,
                    use_pingpong: pingpong,
                    fps: fps_clone,
                    tx_progress: Some(tx),
                    cancel_control: Some(control_clone),
                    tx_stats: stats_tx_ping,
                })
                .await
            }
        });

        while let Some(progress_sec) = rx.recv().await {
            let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].progress_percent = pct / 2;
            }
            state_manager
                .emit_progress_throttled(app, ctx.jobs_arc)
                .await;
        }

        match ffmpeg_task
            .await
            .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))))
        {
            Ok(()) => {}
            Err(e) => {
                cleanup_temp_file(&ping_pong_path).await;
                return Err(e);
            }
        }
    } else {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = "1/2 Using original video".into();
        }
        state_manager
            .emit_progress_from_arc(app, ctx.jobs_arc)
            .await;
        ping_pong_path = PathBuf::from(&input_path);
        created_intermediate = false;
    }

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].current_step = "2/2 Smart loop & muxing".into();
        lock[ctx.index].progress_percent = if created_intermediate { 50 } else { 0 };
    }
    state_manager
        .emit_progress_from_arc(app, ctx.jobs_arc)
        .await;

    // `try_from_rng(&mut SysRng)` seeds from the OS RNG (the panic-free
    // Result form recommended for rand 0.10). The fallback only triggers on
    // an essentially-impossible OS RNG failure and avoids any `.unwrap()`
    // that could panic the task.
    let mut rng = StdRng::try_from_rng(&mut SysRng)
        .unwrap_or_else(|_| StdRng::seed_from_u64(rand::random::<u64>()));
    // Shuffle *indices* instead of cloning the entire master pool just to
    // pick `songs_per_playlist` tracks. This avoids an O(pool_size)
    // allocation (and a copy of every ProcessedAudio) on every job.
    let mut indices: Vec<usize> = (0..params.master_pool.len()).collect();
    indices.shuffle(&mut rng);
    let take_count = params
        .songs_per_playlist
        .min(params.master_pool.len())
        .max(1);
    let selected_songs: Vec<ProcessedAudio> = indices
        .into_iter()
        .take(take_count)
        .map(|i| params.master_pool[i].clone())
        .collect();

    let target_override = crate::config::Target {
        min_duration_sec: params.min_duration_sec,
        padding_sec,
    };
    let audio_list_path = ctx.cache_dir.join(format!("audio_list_{}.txt", timestamp));
    let video_list_path = ctx.cache_dir.join(format!("video_list_{}.txt", timestamp));

    // `generate_loop_playlists` now writes the concat playlists directly
    // to disk via a BufWriter instead of returning giant Strings — this
    // avoids allocating tens of megabytes on the heap for long renders.
    let (timestamps, chapters, total_duration) = match video_loop::generate_loop_playlists(
        app,
        &selected_songs,
        &ping_pong_path,
        target_dur,
        &target_override,
        params.loop_count,
        &audio_list_path,
        &video_list_path,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if created_intermediate {
                cleanup_temp_file(&ping_pong_path).await;
            }
            cleanup_temp_file(&audio_list_path).await;
            cleanup_temp_file(&video_list_path).await;
            return Err(error);
        }
    };

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].timestamps = timestamps.clone();
    }

    event::emit(
        app,
        PipelineEvent::Log {
            level: "info".into(),
            message: format!("=== Timestamps untuk {} ===", name),
        },
    );
    for ts in &timestamps {
        event::emit(
            app,
            PipelineEvent::Log {
                level: "info".into(),
                message: ts.clone(),
            },
        );
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
    let stats_tx_mux = ctx.stats_tx.clone();
    let ffmpeg_task = tokio::spawn({
        let audio_list_path_clone = audio_list_path.clone();
        let video_list_path_clone = video_list_path.clone();
        let output_path_clone = output_path.clone();
        let cache_dir_clone = ctx.cache_dir.to_path_buf();
        let chapters_clone = chapters.clone();
        let control_clone = ctx.control.clone();
        let app_clone = app.clone();
        async move {
            muxer::mux_final_video(
                &app_clone,
                &audio_list_path_clone,
                &video_list_path_clone,
                &output_path_clone,
                total_duration,
                &cache_dir_clone,
                params.embed_chapters,
                &chapters_clone,
                Some(tx),
                Some(control_clone),
                stats_tx_mux,
            )
            .await
        }
    });

    while let Some(progress_sec) = rx.recv().await {
        let pct = (progress_sec / total_duration * 100.0).clamp(0.0, 100.0) as u8;
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].progress_percent = if created_intermediate {
                50 + (pct / 2)
            } else {
                pct
            };
        }
        state_manager
            .emit_progress_throttled(app, ctx.jobs_arc)
            .await;
    }

    let res = ffmpeg_task
        .await
        .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))));

    if created_intermediate {
        cleanup_temp_file(&ping_pong_path).await;
    }
    cleanup_temp_file(&audio_list_path).await;
    cleanup_temp_file(&video_list_path).await;

    match res {
        Ok(()) => {
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].state = JobState::Done;
                lock[ctx.index].progress_percent = 100;
            }
            state_manager
                .emit_progress_from_arc(app, ctx.jobs_arc)
                .await;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::{map_encoder_to_codec, requires_intermediate};

    #[test]
    fn test_av1_aliases_normalize_to_av1() {
        // Includes bare codec name, AOM/SVT software encoder names, the
        // three GPU vendors' AV1 hardware encoder names, plus the Windows
        // Media Foundation (`av1_mf`) and Linux VA-API / V4L2 (`av1_vaapi`,
        // `av1_v4l2m2m`) paths. Every listed string must collapse to the
        // same canonical "av1" token.
        for enc in [
            "av1",
            "libaom-av1",
            "aom",
            "svt-av1",
            "av1_nvenc",
            "av1_amf",
            "av1_qsv",
            "av1_mf",
            "av1_vaapi",
            "av1_v4l2m2m",
            "libsvtav1",
        ] {
            assert_eq!(
                map_encoder_to_codec(enc),
                "av1",
                "AV1 alias '{}' should normalize to 'av1'",
                enc
            );
        }
    }

    #[test]
    fn test_h264_aliases_normalize_to_h264() {
        for enc in ["h264", "libx264", "h264_nvenc", "h264_amf", "h264_qsv"] {
            assert_eq!(
                map_encoder_to_codec(enc),
                "h264",
                "H.264 alias '{}' should normalize to 'h264'",
                enc
            );
        }
    }

    #[test]
    fn test_hevc_aliases_normalize_to_hevc() {
        for enc in ["hevc", "libx265", "hevc_nvenc", "hevc_amf", "hevc_qsv"] {
            assert_eq!(
                map_encoder_to_codec(enc),
                "hevc",
                "HEVC alias '{}' should normalize to 'hevc'",
                enc
            );
        }
    }

    #[test]
    fn test_unknown_encoder_passed_through() {
        // Unrecognised encoders are returned unchanged so the comparison
        // stays transparent — the caller decides whether the resulting
        // mismatch should be treated as a re-encode trigger.
        for enc in ["vp9", "wmv2", "mpeg4", "custom_encoder"] {
            assert_eq!(
                map_encoder_to_codec(enc),
                enc,
                "Unknown encoder '{}' should be returned as-is",
                enc
            );
        }
    }

    #[test]
    fn test_intermediate_policy_keeps_encode_for_codec_mismatch() {
        assert!(requires_intermediate(false, true, true));
    }

    #[test]
    fn test_intermediate_policy_allows_explicit_stream_copy_on_match() {
        assert!(!requires_intermediate(true, true, false));
        assert!(!requires_intermediate(false, true, false));
    }

    #[test]
    fn test_intermediate_policy_applies_pingpong_without_stream_copy() {
        assert!(requires_intermediate(true, false, false));
        assert!(requires_intermediate(false, false, false));
    }

    #[test]
    fn test_skip_reencode_when_aliases_match() {
        // Cross-product check that every recognised AV1 alias compares
        // equal to every other recognised AV1 alias. This is the precise
        // mathematical condition under which `should_reencode` returns
        // `false` and the user's zero-reencode toggle kicks in. If any
        // (alias_x, alias_y) pair were forgotten in the match arm above
        // the test would fail here, protecting the intended behavior
        // (a HandBrake / libaom-av1 source rendered with libsvtav1 skips
        //  the intermediate encode).
        let av1_aliases = [
            "av1",
            "libaom-av1",
            "aom",
            "svt-av1",
            "av1_nvenc",
            "av1_amf",
            "av1_qsv",
            "av1_mf",
            "av1_vaapi",
            "av1_v4l2m2m",
            "libsvtav1",
        ];
        for &a in &av1_aliases {
            for &b in &av1_aliases {
                assert_eq!(
                    map_encoder_to_codec(a),
                    map_encoder_to_codec(b),
                    "AV1 alias pair ('{}', '{}') should both map to 'av1'",
                    a,
                    b
                );
                assert_eq!(
                    map_encoder_to_codec(a),
                    "av1",
                    "AV1 alias '{}' should map to 'av1'",
                    a
                );
            }
        }
        // Cross-codec mismatches stay mismatched after normalization.
        for av1 in &av1_aliases {
            for h264 in ["h264", "libx264", "h264_nvenc"] {
                assert_ne!(
                    map_encoder_to_codec(av1),
                    map_encoder_to_codec(h264),
                    "AV1 alias '{}' must NOT match H.264 alias '{}'",
                    av1,
                    h264
                );
            }
        }
    }
}
