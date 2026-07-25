pub mod audio_pool;
pub mod estimator;
pub mod muxer;
pub mod source_scanner;
pub mod state;
pub mod thumbnailer;
pub mod video_loop;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::job::{JobState, PipelineEvent, RenderJob, RenderStats};
use crate::models::media::{ProcessedAudio, VideoFile};
use crate::models::settings::{MediaSource, OverrideConfig};
use crate::utils::event;
use crate::utils::fs;
use estimator::{
    available_space_for, estimate_total_output_bytes, human_bytes, parse_bitrate_to_kbps,
    sanitize_filename_component,
};
use futures::StreamExt;
use rand::prelude::SliceRandom;
use rand::rngs::{StdRng, SysRng};
use rand::SeedableRng;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

// `TempDirGuard` was removed: thumbnails are intentionally kept after a
// render so the results dashboard can display them. They are purged on cancel
// (see the cancel branch below) and at the start of the next non-resume run
// (which calls `remove_dir_all(&thumb_dir)`).

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
        "av1"
        | "libaom-av1"
        | "aom"
        | "svt-av1"
        | "av1_nvenc"
        | "av1_amf"
        | "av1_qsv"
        | "av1_mf"
        | "av1_vaapi"
        | "av1_v4l2m2m"
        | "libsvtav1" => "av1",
        _ => enc,
    }
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

pub struct Pipeline {
    config: AppConfig,
    app: AppHandle,
    state_manager: state::StateManager,
}

impl Pipeline {
    pub fn new(app: AppHandle, config: AppConfig) -> Self {
        Self {
            app,
            config,
            state_manager: state::StateManager::new(),
        }
    }

    pub async fn execute(
        self,
        overrides: Option<OverrideConfig>,
        resume: bool,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        // Canonicalize a path for use in allowed_roots so that the comparison
        // in resolve_and_validate_path (which uses canonicalize()) matches casing,
        // especially on Windows where Path::starts_with is case-sensitive.
        fn canonicalize_for_root(p: PathBuf) -> PathBuf {
            p.canonicalize().unwrap_or(p)
        }

        let output_dir = fs::to_absolute(&self.resolve_output_dir(&overrides));
        if crate::validation::is_system_protected_path(&output_dir) {
            return Err(AppError::Pipeline(format!(
                "Output directory resolves inside a system-protected location and cannot be used: {}",
                output_dir.display()
            )));
        }
        let mut allowed_roots = vec![
            canonicalize_for_root(output_dir.clone()),
            canonicalize_for_root(fs::to_absolute(Path::new(&self.config.directories.video))),
            canonicalize_for_root(fs::to_absolute(Path::new(&self.config.directories.audio))),
        ];
        // Add override source directories to allowed roots so path validation passes.
        // Folder sources must be added explicitly; file sources are covered by their
        // parents, but the folder path itself is not a parent of its children.
        if let Some(ref ov) = overrides {
            if let Some(ref vs) = ov.video_source {
                match vs {
                    MediaSource::Folder { path } => {
                        allowed_roots.push(canonicalize_for_root(fs::to_absolute(Path::new(path))));
                    }
                    MediaSource::Files { paths } => {
                        for p in paths {
                            if let Some(parent) = Path::new(p).parent() {
                                allowed_roots.push(canonicalize_for_root(fs::to_absolute(parent)));
                            }
                        }
                    }
                }
            }
            if let Some(ref a_src) = ov.audio_source {
                match a_src {
                    MediaSource::Folder { path } => {
                        allowed_roots.push(canonicalize_for_root(fs::to_absolute(Path::new(path))));
                    }
                    MediaSource::Files { paths } => {
                        for p in paths {
                            if let Some(parent) = Path::new(p).parent() {
                                allowed_roots.push(canonicalize_for_root(fs::to_absolute(parent)));
                            }
                        }
                    }
                }
            }
            if let Some(ref output_path) = ov.output_path {
                let _ = crate::validation::resolve_and_validate_path(Path::new(output_path), &allowed_roots)?;
            }
        }
        let cache_dir = fs::ubet_temp_dir().join("cache");
        let thumb_dir = fs::ubet_temp_dir().join("thumbnails");
        let state_path = output_dir.join("ubet_render_state.json");

        if !resume {
            let _ = tokio::fs::remove_dir_all(&thumb_dir).await;
            let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        }

        fs::ensure_dir(&output_dir).await?;
        fs::ensure_dir(&cache_dir).await?;
        fs::ensure_dir(&thumb_dir).await?;

        let render_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_else(|_| {
                // System clock is before Unix epoch (extremely rare).  Log a
                // warning and use a stable fallback so file names are still unique.
                crate::utils::logger::log_line(
                    "WARNING: System clock reported a time before Unix epoch. Using fallback timestamp.",
                );
                // chrono::Utc handles pre-epoch times correctly, which this
                // SystemTime path does not.  Use chrono directly as fallback.
                chrono::Utc::now().timestamp().max(0) as u64
            });

        if control.is_cancelled() {
            return Err(AppError::Cancelled("Render cancelled by user".into()));
        }
        if control.is_paused() {
            control.wait_for_resume().await;
            if control.is_cancelled() {
                return Err(AppError::Cancelled("Render cancelled by user".into()));
            }
        }

        let video_files = source_scanner::scan_source_files(
            &self.app,
            &overrides,
            Path::new(&self.config.directories.video),
            "video",
            &allowed_roots,
        )
        .await?;
        let audio_files = source_scanner::scan_source_files(
            &self.app,
            &overrides,
            Path::new(&self.config.directories.audio),
            "audio",
            &allowed_roots,
        )
        .await?;

        if video_files.is_empty() {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "error".into(),
                    message: "No video files selected or found".into(),
                },
            );
            return Err(AppError::NoVideo);
        }
        if audio_files.is_empty() {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "error".into(),
                    message: "No audio files selected or found".into(),
                },
            );
            return Err(AppError::NoAudio);
        }

        // Extract overrides reference once to avoid repeated .as_ref() calls
        let ov = overrides.as_ref();
        let use_pingpong = ov.and_then(|o| o.use_pingpong).unwrap_or(true);
        let audio_mode = ov
            .and_then(|o| o.audio_mode.clone())
            .unwrap_or_else(|| self.config.audio.audio_mode.clone());
        let embed_chapters = ov
            .and_then(|o| o.embed_chapters)
            .unwrap_or(self.config.embed_chapters);

        let songs_per_playlist = ov.and_then(|o| o.songs_per_playlist).unwrap_or(self.config.audio.songs_per_playlist).max(1);
        let min_duration_sec = ov.and_then(|o| o.min_duration_hours).map(|h| (h * 3600.0) as u64).unwrap_or(self.config.target.min_duration_sec);
        let loop_count = ov.and_then(|o| o.loop_count);

        let encoder_selected = ov.and_then(|o| o.encoder.clone());
        let prefix = ov.and_then(|o| o.output_prefix.as_deref()).unwrap_or(&self.config.metadata.channel_prefix);
        let safe_prefix = sanitize_filename_component(prefix);

        // Honor the user's "stream-copy when codec matches" preference.
        // Defaults to `true` so we honor the README's "Zero-Reencode Muxing"
        // promise for AV1->AV1 and H.264->H.264 alike. Users who explicitly
        // want the intermediate filter chain (for the ping-pong mirror
        // visual effect even when the codec already matches) can disable
        // this from the Settings UI.
        let skip_intermediate_on_codec_match = ov
            .and_then(|o| o.skip_intermediate_on_codec_match)
            .unwrap_or(true);

        // Output container chosen by the user (MP4 or MKV). This decouples the
        // final file extension from the input file's extension, so e.g. a
        // `.webm`/`.avi` source can still be encoded to a universally supported
        // container (previously the container followed the input extension).
        let output_format = ov
            .and_then(|o| o.output_format.clone())
            .unwrap_or_else(|| "mp4".to_string());
        let output_ext = if output_format.eq_ignore_ascii_case("mkv") {
            "mkv"
        } else {
            "mp4"
        };

        let maxrate_str = ov.and_then(|o| o.maxrate.clone()).unwrap_or_else(|| self.config.video.bitrate_target.clone());
        let maxrate_k = parse_bitrate_to_kbps(&maxrate_str).unwrap_or_else(|| {
            event::emit(&self.app, PipelineEvent::Log {
                level: "warn".into(),
                message: format!("Invalid bitrate '{}', falling back to 4000k", maxrate_str),
            });
            4000
        }).max(1);
        let target_k = (maxrate_k as f64 * 0.7).ceil() as u32;

        let mut video_cfg = self.config.video.clone();
        video_cfg.bitrate_target = format!("{}k", target_k);
        video_cfg.bitrate_max = format!("{}k", maxrate_k);

        if let Some(enc) = encoder_selected.as_deref() {
            video_cfg.encoder = enc.to_string();
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Building master audio pool...".into() });

        let master_pool = audio_pool::build_master_audio_pool(
            &self.app,
            &cache_dir,
            &audio_files,
            &self.config.audio,
            &audio_mode,
            Some(control.clone()),
        )
        .await?;

        if master_pool.is_empty() {
            return Err(AppError::NoAudio);
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: format!("{} songs ready.", master_pool.len()) });

        let mut initial_jobs = if resume && state_path.exists() {
            match tokio::fs::read_to_string(&state_path).await {
                Ok(content) => match serde_json::from_str::<Vec<RenderJob>>(&content) {
                    Ok(mut saved_jobs) => {
                        for j in &mut saved_jobs {
                            if j.state != JobState::Done {
                                j.state = JobState::Pending;
                                j.progress_percent = 0;
                                j.current_step = "Pending".into();
                                j.error = None;
                            }
                        }
                        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Resuming previous render state...".into() });
                        saved_jobs
                    }
                    Err(_) => self.create_initial_jobs(&video_files, &safe_prefix, &output_dir, output_ext),
                },
                Err(_) => self.create_initial_jobs(&video_files, &safe_prefix, &output_dir, output_ext),
            }
        } else {
            self.create_initial_jobs(&video_files, &safe_prefix, &output_dir, output_ext)
        };

        if !resume {
            event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Generating thumbnails...".into() });
            thumbnailer::generate_thumbnails(&self.app, &mut initial_jobs, &thumb_dir, control.clone()).await;
        }

        if control.is_cancelled() {
            let _ = self.state_manager.save_state(&state_path, &initial_jobs).await;
            return Err(AppError::Cancelled("Render cancelled by user".into()));
        }
        if control.is_paused() {
            let _ = self.state_manager.save_state(&state_path, &initial_jobs).await;
            return Err(AppError::Paused("Render paused by user".into()));
        }

        let jobs_arc = Arc::new(tokio::sync::Mutex::new(initial_jobs));
        self.state_manager.emit_progress_from_arc(&self.app, &jobs_arc).await;

        let total_jobs = jobs_arc.lock().await.len();
        let pipeline_arc = Arc::new(self);
        let encoder_arc = encoder_selected.map(Arc::new);

        // --- Live render-stats channel -------------------------------------
        // ffmpeg prints speed=/bitrate=/fps= on stderr; the encoder tasks send
        // parsed RenderStats here and this forwarder re-emits them as
        // PipelineEvent::Stats so the UI can show a real-time render readout.
        // A single channel serves every job (jobs run sequentially).
        let (stats_tx, mut stats_rx) = tokio::sync::mpsc::channel::<RenderStats>(64);
        let stats_app = pipeline_arc.app.clone();
        let stats_handle = tokio::spawn(async move {
            while let Some(s) = stats_rx.recv().await {
                event::emit(
                    &stats_app,
                    PipelineEvent::Stats {
                        speed: s.speed,
                        bitrate_kbps: s.bitrate_kbps,
                        fps: s.fps,
                    },
                );
            }
        });

        // --- Disk-space pre-check ------------------------------------------
        // Warn (non-fatally) if the estimated total output size exceeds the
        // free space on the output drive, so the user isn't surprised by a
        // mid-render failure.
        let num_jobs = total_jobs;
        let avg_song_sec = master_pool.iter().map(|s| s.duration).sum::<f64>()
            / (master_pool.len().max(1) as f64);
        let est_bytes = estimate_total_output_bytes(
            num_jobs,
            maxrate_k,
            avg_song_sec,
            songs_per_playlist,
            min_duration_sec,
            loop_count,
        );
        let avail = available_space_for(&output_dir);
        if avail > 0 && est_bytes > avail {
            event::emit(
                &pipeline_arc.app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!(
                        "Estimated output size ({}) exceeds free space on the output drive ({}). The render may fail due to insufficient space.",
                        human_bytes(est_bytes),
                        human_bytes(avail)
                    ),
                },
            );
        }

        let indices: Vec<usize> = (0..total_jobs).collect();
        let stream = futures::stream::iter(indices);
        let stats_tx_for_stream = stats_tx.clone();

        stream.for_each(|i| {
            let p_arc = Arc::clone(&pipeline_arc);
            let j_arc = Arc::clone(&jobs_arc);
            let cache_clone = cache_dir.clone();
            let c_clone = control.clone();
            let vcfg_clone = video_cfg.clone();
            let e_arc = encoder_arc.clone();
            let m_pool = master_pool.clone();
            let s_path = state_path.clone();
            let stats_tx_clone = stats_tx_for_stream.clone();

            async move {
                if c_clone.is_cancelled() {
                    return;
                }
                if c_clone.is_paused() {
                    // Don't wait for resume here - return early so the pipeline
                    // terminates, runs cleanup, and saves state.
                    // On resume, a fresh pipeline will be created from the state file.
                    let _ = p_arc.state_manager.save_state_from_arc(&s_path, &j_arc).await;
                    return;
                }

                let skip = {
                    let lock = j_arc.lock().await;
                    Path::new(&lock[i].video.output_path).exists() && lock[i].state == JobState::Done
                };

                if skip {
                    p_arc.state_manager.emit_progress_from_arc(&p_arc.app, &j_arc).await;
                    let _ = p_arc.state_manager.save_state_from_arc(&s_path, &j_arc).await;
                    return;
                }

                let ctx = JobContext {
                    index: i,
                    jobs_arc: &j_arc,
                    cache_dir: &cache_clone,
                    render_timestamp,
                    control: c_clone.clone(),
                    stats_tx: Some(stats_tx_clone),
                };
                let params = JobParams {
                    use_pingpong,
                    skip_intermediate_on_codec_match,
                    video_cfg: vcfg_clone.clone(),
                    encoder_selected: e_arc.as_deref().map(|s| s.to_string()),
                    master_pool: m_pool.clone(),
                    songs_per_playlist,
                    min_duration_sec,
                    loop_count,
                    embed_chapters,
                };

                let result = p_arc.process_single_job(ctx, params).await;

                match result {
                    Ok(()) => {
                        event::emit(
                            &p_arc.app,
                            PipelineEvent::Log { level: "success".into(), message: format!("Job {} finished", i) },
                        );
                    }
                    Err(AppError::Cancelled(_)) => {}
                    Err(AppError::Paused(_)) => {
                        // State is saved by the call at the bottom of this closure
                    }
                    Err(e) => {
                        {
                            let mut lock = j_arc.lock().await;
                            lock[i].state = JobState::Error;
                            lock[i].error = Some(e.to_string());
                        }
                        p_arc.state_manager.emit_progress_from_arc(&p_arc.app, &j_arc).await;
                    }
                }

                let _ = p_arc.state_manager.save_state_from_arc(&s_path, &j_arc).await;
            }
        }).await;

        // All jobs finished: drop the last stats senders so the forwarder task
        // drains and exits, then wait for it to finish.
        // `stats_tx_for_stream` is still alive after `for_each` (the closure only
        // borrows it by reference), so we must drop it explicitly here.  If we
        // skip this, the channel stays open and `stats_handle.await` hangs
        // forever, preventing the `Done` event from ever reaching the frontend.
        drop(stats_tx_for_stream);
        drop(stats_tx);
        let _ = stats_handle.await;

        if control.is_paused() {
            // Flush state immediately (bypassing the 2s throttle) so the most
            // recently finished job isn't lost when the next resume reloads it.
            {
                let jobs = jobs_arc.lock().await.clone();
                let _ = pipeline_arc.state_manager.save_state(&state_path, &jobs).await;
            }
            return Err(AppError::Paused("Render paused by user".into()));
        } else if control.is_cancelled() {
            let _ = tokio::fs::remove_dir_all(&cache_dir).await;
            let _ = tokio::fs::remove_dir_all(&thumb_dir).await;
            let _ = tokio::fs::remove_file(&state_path).await;
            return Err(AppError::Cancelled("Render cancelled by user".into()));
        }

        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        let _ = tokio::fs::remove_file(&state_path).await;

        let final_jobs = jobs_arc.lock().await.clone();

        if !final_jobs.is_empty() {
            let mut all_timestamps = Vec::new();
            for job in &final_jobs {
                if !job.timestamps.is_empty() {
                    all_timestamps.extend(job.timestamps.clone());
                    all_timestamps.push("".into());
                }
            }
            let parent_opt = final_jobs.first().map(|j| &j.video.output_path).and_then(|p| Path::new(p).parent());
            if let Some(parent) = parent_opt.filter(|_| !all_timestamps.is_empty()) {
                let combined_path = parent.join("all_timestamps.txt");
                let _ = tokio::fs::write(&combined_path, all_timestamps.join("\n")).await;
            }
        }
        let failed = final_jobs.iter().filter(|j| j.state == JobState::Error).count();
        let completed = final_jobs.iter().filter(|j| j.state == JobState::Done).count();

        event::emit(
            &pipeline_arc.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!("Render finished: {}/{} completed, {} failed", completed, total_jobs, failed),
            },
        );
        event::emit(&pipeline_arc.app, PipelineEvent::Done { completed, total: total_jobs, failed });
        Ok(())
    }

    fn create_initial_jobs(
        &self,
        video_files: &[String],
        safe_prefix: &str,
        output_dir: &Path,
        output_ext: &str,
    ) -> Vec<RenderJob> {
        let mut jobs = Vec::new();
        let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        for (idx, path_str) in video_files.iter().enumerate() {
            let input_path = Path::new(path_str);
            let name = input_path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
            let stem = Path::new(&name).file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");
            let ext = output_ext;
            let unique_name = format!("{}_{}_{}.{}", stem, ts, idx, ext);
            let output_name = if safe_prefix.is_empty() { unique_name } else { format!("{}_{}", safe_prefix, unique_name) };
            jobs.push(RenderJob {
                video: VideoFile {
                    name,
                    input_path: path_str.clone(),
                    output_path: output_dir.join(&output_name).to_string_lossy().to_string(),
                    thumbnail_path: None,
                },
                state: JobState::Pending,
                progress_percent: 0,
                current_step: "Waiting for turn".into(),
                error: None,
                timestamps: Vec::new(),
            });
        }
        jobs
    }

    async fn process_single_job(
        &self,
        ctx: JobContext<'_>,
        params: JobParams,
    ) -> Result<(), AppError> {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].state = JobState::Processing;
            lock[ctx.index].current_step = "Preparing".into();
        }
        self.state_manager.emit_progress_from_arc(&self.app, ctx.jobs_arc).await;

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
            match ffmpeg::get_video_info(&self.app, Path::new(&input_path)).await {
                Ok(info) => (info.codec, info.frame_rate, Ok(info.duration)),
                Err(_) => (
                    None,
                    30.0,
                    ffmpeg::get_duration(&self.app, Path::new(&input_path)).await,
                ),
            };
        let input_duration = input_duration.map_err(|_| {
            AppError::Pipeline(format!("Failed to detect video duration: {}", name))
        })?;

        let should_reencode = match (&input_codec, params.encoder_selected.as_deref()) {
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
        };

        let ping_pong_path;
        let created_intermediate;
        let target_dur = input_duration.max(0.001) * if params.use_pingpong { 2.0 } else { 1.0 };

        // Decide whether the intermediate re-encode (the "1/2 ..." step) is
        // actually required. Two paths:
        //
        // 1. Zero-reencode mode (skip_intermediate_on_codec_match = true):
        //    the user has explicitly opted into stream-copy. We bypass the
        //    intermediate file entirely and go straight to the concat
        //    demuxer with `-c copy`, regardless of `should_reencode` and
        //    `use_pingpong`. If source and target codecs truly differ,
        //    FFmpeg will fail with a clear error in the muxer stage — that
        //    is the correct visible failure mode; silently re-encoding
        //    would contradict the user's intent.
        //
        // 2. Smart heuristic (skip_intermediate_on_codec_match = false):
        //    legacy behaviour — only skip the intermediate when the codec
        //    detection SUCCEEDED and matches the target encoder.
        //    The earlier `_ => true` fallback in `should_reencode` is
        //    intentionally preserved here so a user who has not opted into
        //    zero-reencode still gets a safe default.
        let skip_match = params.skip_intermediate_on_codec_match;
        // Single-line derivation: skip-intermediate takes precedence; only run
        // the legacy heuristic when the user has NOT opted into zero-reencode.
        let needs_intermediate =
            !skip_match && (should_reencode || params.use_pingpong);

        // Tell the user exactly why we are or are not skipping, so the
        // silent zero-reencode is never mistaken for a stuck progress bar.
        if skip_match {
            // Resolve the effective encoder using the same fallback as
            // `should_reencode` above (encoder_selected takes priority over
            // the configured default) so the user-facing comparison reflects
            // the encoder that really decides whether mux succeeds.
            let effective_encoder = params
                .encoder_selected
                .as_deref()
                .unwrap_or(params.video_cfg.encoder.as_str());
            let mapped_effective = map_encoder_to_codec(effective_encoder);
            // Normalize the input side as well so the user-facing message
            // agrees with what `should_reencode` decided (a `libaom-av1`
            // source is reported as `av1`, not as the raw ffprobe string).
            let codec_note = match &input_codec {
                Some(c) if map_encoder_to_codec(c) != mapped_effective => format!(
                    " Source codec '{}' (canonical: {}) != target '{}'; FFmpeg muxer will fail if a real codec mismatch — toggle this OFF if so.",
                    c, map_encoder_to_codec(c), mapped_effective
                ),
                None => {
                    " Source codec unavailable (ffprobe fallback); FFmpeg muxer will skip silently if compatible.".to_string()
                }
                _ => String::new(),
            };
            let pingpong_note = if params.use_pingpong {
                " Note: ping-pong visual effect disabled by zero-reencode mode."
            } else {
                ""
            };
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "info".into(),
                    message: format!(
                        "Zero-reencode mode ON: skipping intermediate encode, using source as-is via -c copy.{}{}",
                        codec_note, pingpong_note
                    ),
                },
            );
        } else if params.use_pingpong && !should_reencode {
            // Use the canonical (normalized) codec name so the user sees the
            // same wording in both the legacy log and the skip_match branch.
            let canonical = input_codec
                .as_deref()
                .map(map_encoder_to_codec)
                .unwrap_or("unknown");
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "info".into(),
                    message: format!(
                        "Source codec matches target ({}). Skipping ping-pong intermediate.",
                        canonical
                    ),
                },
            );
        }

        if needs_intermediate {
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].current_step = if params.use_pingpong { "1/2 Upscaling & ping-pong".into() } else { "1/2 Re-encoding video".into() };
            }
            self.state_manager.emit_progress_from_arc(&self.app, ctx.jobs_arc).await;

            ping_pong_path = ctx.cache_dir.join(format!("intermediate_{}.mp4", timestamp));
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
                let app_clone = self.app.clone();
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
                    }).await
                }
            });

            while let Some(progress_sec) = rx.recv().await {
                let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
                {
                    let mut lock = ctx.jobs_arc.lock().await;
                    lock[ctx.index].progress_percent = pct / 2;
                }
                self.state_manager.emit_progress_throttled(&self.app, ctx.jobs_arc).await;
            }

            match ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e)))) {
                Ok(()) => {}
                Err(e) => {
                    let _ = fs::safe_delete(&ping_pong_path).await;
                    return Err(e);
                }
            }
        } else {
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].current_step = "1/2 Using original video".into();
            }
            self.state_manager.emit_progress_from_arc(&self.app, ctx.jobs_arc).await;
            ping_pong_path = PathBuf::from(&input_path);
            created_intermediate = false;
        }

        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = "2/2 Smart loop & muxing".into();
            lock[ctx.index].progress_percent = if created_intermediate { 50 } else { 0 };
        }
        self.state_manager.emit_progress_from_arc(&self.app, ctx.jobs_arc).await;

        // `try_from_rng(&mut SysRng)` seeds from the OS RNG (the panic-free
        // Result form recommended for rand 0.10). The fallback only triggers on
        // an essentially-impossible OS RNG failure and avoids any `.unwrap()`
        // that could panic the task.
        let mut rng = StdRng::try_from_rng(&mut SysRng).unwrap_or_else(|_| {
            StdRng::seed_from_u64(rand::random::<u64>())
        });
        // Shuffle *indices* instead of cloning the entire master pool just to
        // pick `songs_per_playlist` tracks. This avoids an O(pool_size)
        // allocation (and a copy of every ProcessedAudio) on every job.
        let mut indices: Vec<usize> = (0..params.master_pool.len()).collect();
        indices.shuffle(&mut rng);
        let take_count = params.songs_per_playlist.min(params.master_pool.len()).max(1);
        let selected_songs: Vec<ProcessedAudio> = indices
            .into_iter()
            .take(take_count)
            .map(|i| params.master_pool[i].clone())
            .collect();

        let target_override = crate::config::Target {
            min_duration_sec: params.min_duration_sec,
            padding_sec: self.config.target.padding_sec,
        };
        let audio_list_path = ctx.cache_dir.join(format!("audio_list_{}.txt", timestamp));
        let video_list_path = ctx.cache_dir.join(format!("video_list_{}.txt", timestamp));

        // `generate_loop_playlists` now writes the concat playlists directly
        // to disk via a BufWriter instead of returning giant Strings — this
        // avoids allocating tens of megabytes on the heap for long renders.
        let (timestamps, chapters, total_duration) =
            video_loop::generate_loop_playlists(
                &self.app,
                &selected_songs,
                &ping_pong_path,
                target_dur,
                &target_override,
                params.loop_count,
                &audio_list_path,
                &video_list_path,
            )
            .await?;

        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].timestamps = timestamps.clone();
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: format!("=== Timestamps untuk {} ===", name) });
        for ts in &timestamps {
            event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: ts.clone() });
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
            let app_clone = self.app.clone();
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
                ).await
            }
        });

        while let Some(progress_sec) = rx.recv().await {
            let pct = (progress_sec / total_duration * 100.0).clamp(0.0, 100.0) as u8;
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].progress_percent = if created_intermediate { 50 + (pct / 2) } else { pct };
            }
            self.state_manager.emit_progress_throttled(&self.app, ctx.jobs_arc).await;
        }

        let res = ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))));

        if created_intermediate { let _ = fs::safe_delete(&ping_pong_path).await; }
        let _ = fs::safe_delete(&audio_list_path).await;
        let _ = fs::safe_delete(&video_list_path).await;

        match res {
            Ok(()) => {
                {
                    let mut lock = ctx.jobs_arc.lock().await;
                    lock[ctx.index].state = JobState::Done;
                    lock[ctx.index].progress_percent = 100;
                }
                self.state_manager.emit_progress_from_arc(&self.app, ctx.jobs_arc).await;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    fn resolve_output_dir(&self, overrides: &Option<OverrideConfig>) -> PathBuf {
        if let Some(path) = overrides.as_ref().and_then(|ov| ov.output_path.as_ref()) {
            return PathBuf::from(path);
        }
        PathBuf::from(&self.config.directories.output)
    }
}

#[cfg(test)]
mod tests {
    use super::map_encoder_to_codec;

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
            "av1", "libaom-av1", "aom", "svt-av1", "av1_nvenc", "av1_amf",
            "av1_qsv", "av1_mf", "av1_vaapi", "av1_v4l2m2m", "libsvtav1",
        ];
        for &a in &av1_aliases {
            for &b in &av1_aliases {
                assert_eq!(
                    map_encoder_to_codec(a),
                    map_encoder_to_codec(b),
                    "AV1 alias pair ('{}', '{}') should both map to 'av1'",
                    a, b
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
                    av1, h264
                );
            }
        }
    }
}

