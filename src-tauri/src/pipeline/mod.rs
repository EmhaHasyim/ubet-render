pub mod audio_pool;
pub mod estimator;
pub mod job_processor;
pub mod loop_control;
pub mod muxer;
pub mod roots;
pub mod source_scanner;
pub mod state;
pub mod thumbnailer;
pub mod video_loop;
pub mod workspace_guard;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::job::{JobState, PipelineEvent, RenderJob, RenderStats};
use crate::models::media::VideoFile;
use crate::models::settings::OverrideConfig;
use crate::utils::event;
use crate::utils::fs;
use estimator::{
    available_space_for, estimate_total_output_bytes, human_bytes, parse_bitrate_to_kbps,
    sanitize_filename_component,
};
pub use job_processor::{JobContext, JobParams};
use roots::ResolvedRoots;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use workspace_guard::{WorkspaceGuard, quarantine_state_file};

// `TempDirGuard` was removed: thumbnails are intentionally kept after a
// render so the results dashboard can display them. They are purged on cancel
// (see the cancel branch below) and at the start of the next non-resume run
// (which calls `remove_dir_all(&thumb_dir)`).
//
// `WorkspaceGuard` lives in `pipeline/workspace_guard.rs`.

pub struct Pipeline {
    config: AppConfig,
    app: AppHandle,
    state_manager: state::StateManager,
}

/// Parsed per-run overrides. Extracted so `execute()` orchestrates instead of
/// inlining ~60 lines of `ov.and_then(...)` plumbing.
struct ExecutionParams {
    use_pingpong: bool,
    audio_mode: String,
    embed_chapters: bool,
    songs_per_playlist: usize,
    min_duration_sec: u64,
    loop_count: Option<usize>,
    encoder_selected: Option<String>,
    safe_prefix: String,
    output_ext: &'static str,
    maxrate_k: u32,
    video_cfg: crate::config::VideoSettings,
    skip_intermediate_on_codec_match: bool,
}

impl Pipeline {
    pub fn new(app: AppHandle, config: AppConfig) -> Self {
        Self {
            app,
            config,
            state_manager: state::StateManager::new(),
        }
    }

    fn parse_params(&self, overrides: &Option<OverrideConfig>) -> ExecutionParams {
        let ov = overrides.as_ref();
        let use_pingpong = ov.and_then(|o| o.use_pingpong).unwrap_or(true);
        let audio_mode = ov
            .and_then(|o| o.audio_mode.clone())
            .unwrap_or_else(|| self.config.audio.audio_mode.clone());
        let embed_chapters = ov
            .and_then(|o| o.embed_chapters)
            .unwrap_or(self.config.embed_chapters);
        let songs_per_playlist = ov
            .and_then(|o| o.songs_per_playlist)
            .unwrap_or(self.config.audio.songs_per_playlist)
            .max(1);
        let min_duration_sec = ov
            .and_then(|o| o.min_duration_hours)
            .map(|h| (h * 3600.0) as u64)
            .unwrap_or(self.config.target.min_duration_sec);
        let loop_count = ov.and_then(|o| o.loop_count);
        let encoder_selected = ov.and_then(|o| o.encoder.clone());
        let prefix = ov
            .and_then(|o| o.output_prefix.as_deref())
            .unwrap_or(&self.config.metadata.channel_prefix);
        let safe_prefix = sanitize_filename_component(prefix);
        let skip_intermediate_on_codec_match = ov
            .and_then(|o| o.skip_intermediate_on_codec_match)
            .unwrap_or(false);
        let output_format = ov
            .and_then(|o| o.output_format.clone())
            .unwrap_or_else(|| "mp4".to_string());
        let output_ext = if output_format.eq_ignore_ascii_case("mkv") {
            "mkv"
        } else {
            "mp4"
        };
        let maxrate_str = ov
            .and_then(|o| o.maxrate.clone())
            .unwrap_or_else(|| self.config.video.bitrate_target.clone());
        let maxrate_k = parse_bitrate_to_kbps(&maxrate_str).unwrap_or(4000).max(1);
        if parse_bitrate_to_kbps(&maxrate_str).is_none() {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!("Invalid bitrate '{}', falling back to 4000k", maxrate_str),
                },
            );
        }
        let target_k = (maxrate_k as f64 * 0.7).ceil() as u32;
        let mut video_cfg = self.config.video.clone();
        video_cfg.bitrate_target = format!("{}k", target_k);
        video_cfg.bitrate_max = format!("{}k", maxrate_k);
        if let Some(enc) = encoder_selected.as_deref() {
            video_cfg.encoder = enc.to_string();
        }
        ExecutionParams {
            use_pingpong,
            audio_mode,
            embed_chapters,
            songs_per_playlist,
            min_duration_sec,
            loop_count,
            encoder_selected,
            safe_prefix,
            output_ext,
            maxrate_k,
            video_cfg,
            skip_intermediate_on_codec_match,
        }
    }

    pub async fn execute(
        self,
        overrides: Option<OverrideConfig>,
        resume: bool,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        let ResolvedRoots {
            output_dir,
            input_roots,
            cache_dir,
            thumb_dir,
            state_path,
        } = roots::resolve_roots(&self.config, &overrides)?;

        let mut workspace =
            WorkspaceGuard::new(cache_dir.clone(), thumb_dir.clone(), state_path.clone());

        if !resume {
            let _ = tokio::fs::remove_dir_all(&thumb_dir).await;
            // Only the app-owned render namespace is disposable; never remove
            // the configured cache root itself because it may contain unrelated
            // user files (or even be the same directory as the output root).
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
            // Pause is a graceful stop. Do not wait indefinitely before the
            // first scan/probe; return so the task can persist/quiesce and the
            // next resume starts from the durable state file.
            control.mark_terminated();
            return Err(AppError::Paused("Render paused by user".into()));
        }

        let video_files = source_scanner::scan_source_files(
            &self.app,
            &overrides,
            Path::new(&self.config.directories.video),
            "video",
            &input_roots,
        )
        .await?;
        let audio_files = source_scanner::scan_source_files(
            &self.app,
            &overrides,
            Path::new(&self.config.directories.audio),
            "audio",
            &input_roots,
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

        let params = self.parse_params(&overrides);
        let ExecutionParams {
            use_pingpong,
            audio_mode,
            embed_chapters,
            songs_per_playlist,
            min_duration_sec,
            loop_count,
            encoder_selected,
            safe_prefix,
            output_ext,
            maxrate_k,
            video_cfg,
            skip_intermediate_on_codec_match,
        } = params;

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: "Building master audio pool...".into(),
            },
        );

        let master_pool = match audio_pool::build_master_audio_pool(
            &self.app,
            &cache_dir,
            &audio_files,
            &self.config.audio,
            &audio_mode,
            Some(control.clone()),
        )
        .await
        {
            Ok(pool) => pool,
            Err(AppError::Paused(message)) => {
                workspace.pause();
                // The pipeline has committed to exiting; a concurrent resume
                // must restart from the durable state instead of reviving this
                // task after its FFmpeg child has already stopped.
                control.mark_terminated();
                return Err(AppError::Paused(message));
            }
            Err(AppError::Cancelled(message)) => {
                workspace.cancel();
                return Err(AppError::Cancelled(message));
            }
            Err(error) => return Err(error),
        };

        if master_pool.is_empty() {
            return Err(AppError::NoAudio);
        }

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!("{} songs ready.", master_pool.len()),
            },
        );

        if resume
            && state_path.exists()
            && let Ok(metadata) = tokio::fs::metadata(&state_path).await
            && metadata.len() > crate::validation::MAX_RESUME_STATE_BYTES
        {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!(
                        "Saved render state is too large ({} bytes); quarantining it and starting a fresh batch.",
                        metadata.len()
                    ),
                },
            );
            if !quarantine_state_file(&state_path, render_timestamp) {
                workspace.cancel();
                return Err(AppError::Pipeline(
                    "Oversized render state could not be quarantined".into(),
                ));
            }
        }

        let mut initial_jobs = self
            .load_resume_or_fresh(
                resume,
                &state_path,
                &video_files,
                &safe_prefix,
                &output_dir,
                output_ext,
                &input_roots,
                &thumb_dir,
                &mut workspace,
                render_timestamp,
            )
            .await?;

        if !resume {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "info".into(),
                    message: "Generating thumbnails...".into(),
                },
            );
            thumbnailer::generate_thumbnails(
                &self.app,
                &mut initial_jobs,
                &thumb_dir,
                control.clone(),
            )
            .await;
        }

        if control.is_cancelled() {
            let _ = self
                .state_manager
                .save_state(&state_path, &initial_jobs)
                .await;
            workspace.cancel();
            return Err(AppError::Cancelled("Render cancelled by user".into()));
        }
        if control.is_paused() {
            let _ = self
                .state_manager
                .save_state(&state_path, &initial_jobs)
                .await;
            workspace.pause();
            control.mark_terminated();
            return Err(AppError::Paused("Render paused by user".into()));
        }

        let jobs_arc = Arc::new(tokio::sync::Mutex::new(initial_jobs));
        self.state_manager
            .emit_progress_from_arc(&self.app, &jobs_arc)
            .await;

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
        let avg_song_sec =
            master_pool.iter().map(|s| s.duration).sum::<f64>() / (master_pool.len().max(1) as f64);
        let est_bytes = estimate_total_output_bytes(
            num_jobs,
            maxrate_k,
            avg_song_sec,
            songs_per_playlist,
            min_duration_sec,
            loop_count,
        );
        let avail = available_space_for(&output_dir).await;
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

        let stats_tx_for_stream = stats_tx.clone();

        // Process jobs sequentially in an explicit loop. A plain loop (instead
        // of `futures::stream::iter().for_each()`) lets us *retry the current
        // job in place*: if a pause is acknowledged mid-job but the user has
        // already resumed, the pipeline is still alive and we re-run the
        // interrupted job instead of leaving it as a zombie `processing` row
        // (or terminating the whole batch). If the pipeline is still paused
        // we persist state and terminate — a later resume starts a fresh
        // pipeline from the state file.
        let mut idx = 0usize;
        let mut pause_exit = false;
        let milestone_step = loop_control::milestone_step(total_jobs);
        let mut completed: usize = 0;
        let mut last_milestone: usize = 0;
        while idx < total_jobs {
            if control.is_cancelled() {
                break;
            }
            if control.is_paused() {
                // Persist and terminate — resume restarts from the state file.
                let _ = pipeline_arc
                    .state_manager
                    .save_state_from_arc(&state_path, &jobs_arc)
                    .await;
                pause_exit = true;
                control.mark_terminated();
                break;
            }

            let skip = {
                let lock = jobs_arc.lock().await;
                loop_control::should_skip_job(&lock[idx])
            };

            if skip {
                pipeline_arc
                    .state_manager
                    .emit_progress_from_arc(&pipeline_arc.app, &jobs_arc)
                    .await;
                let _ = pipeline_arc
                    .state_manager
                    .save_state_from_arc(&state_path, &jobs_arc)
                    .await;
                completed += 1;
                if loop_control::is_milestone(completed, total_jobs, last_milestone, milestone_step)
                {
                    event::emit(
                        &pipeline_arc.app,
                        PipelineEvent::Log {
                            level: "success".into(),
                            message: format!("Videos: {}/{} done", completed, total_jobs),
                        },
                    );
                    last_milestone = loop_control::milestone_band(completed, milestone_step);
                }
                idx += 1;
                continue;
            }

            let ctx = JobContext {
                index: idx,
                jobs_arc: &jobs_arc,
                cache_dir: &cache_dir,
                render_timestamp,
                control: control.clone(),
                stats_tx: Some(stats_tx_for_stream.clone()),
            };
            let params = JobParams {
                use_pingpong,
                skip_intermediate_on_codec_match,
                video_cfg: video_cfg.clone(),
                encoder_selected: encoder_arc.as_deref().map(|s| s.to_string()),
                master_pool: master_pool.clone(),
                songs_per_playlist,
                min_duration_sec,
                loop_count,
                embed_chapters,
            };

            let result = job_processor::process_single_job(
                &pipeline_arc.app,
                &pipeline_arc.state_manager,
                pipeline_arc.config.target.padding_sec,
                ctx,
                params,
            )
            .await;

            let action = loop_control::decide_next_action(&result, control.is_paused());
            match action {
                loop_control::LoopAction::Advance => {
                    if let Err(ref e) = result {
                        {
                            let mut lock = jobs_arc.lock().await;
                            lock[idx].state = JobState::Error;
                            lock[idx].error = Some(e.to_string());
                        }
                        pipeline_arc
                            .state_manager
                            .emit_progress_from_arc(&pipeline_arc.app, &jobs_arc)
                            .await;
                        let _ = pipeline_arc
                            .state_manager
                            .save_state_from_arc(&state_path, &jobs_arc)
                            .await;
                    }
                    completed += 1;
                    if loop_control::is_milestone(
                        completed,
                        total_jobs,
                        last_milestone,
                        milestone_step,
                    ) {
                        event::emit(
                            &pipeline_arc.app,
                            PipelineEvent::Log {
                                level: "success".into(),
                                message: format!("Videos: {}/{} done", completed, total_jobs),
                            },
                        );
                        last_milestone = loop_control::milestone_band(completed, milestone_step);
                    }
                    idx += 1;
                }
                loop_control::LoopAction::Retry => {
                    // Pause→quick-resume race: retry the same job immediately
                    // so the batch continues cleanly.
                    continue;
                }
                loop_control::LoopAction::Break => {
                    // Cancelled or paused mid-job: persist what we have
                    // and terminate.
                    let _ = pipeline_arc
                        .state_manager
                        .save_state_from_arc(&state_path, &jobs_arc)
                        .await;
                    if matches!(result, Err(AppError::Paused(_))) {
                        pause_exit = true;
                        control.mark_terminated();
                    }
                    break;
                }
            }
        }

        // All jobs finished: drop the last stats senders so the forwarder task
        // drains and exits, then wait for it to finish.
        // `stats_tx_for_stream` is still alive after the loop (each job only
        // cloned it), so we must drop it explicitly here.  If we skip this,
        // the channel stays open and `stats_handle.await` hangs forever,
        // preventing the `Done` event from ever reaching the frontend.
        drop(stats_tx_for_stream);
        drop(stats_tx);
        let _ = stats_handle.await;

        if pause_exit || control.is_paused() {
            // Flush state immediately (bypassing the 2s throttle) so the most
            // recently finished job isn't lost when the next resume reloads it.
            // Snapshot under a short lock scope — clone, drop, then write.
            {
                let jobs = { jobs_arc.lock().await.clone() };
                let _ = pipeline_arc
                    .state_manager
                    .save_state(&state_path, &jobs)
                    .await;
            }
            workspace.pause();
            control.mark_terminated();
            return Err(AppError::Paused("Render paused by user".into()));
        } else if control.is_cancelled() {
            workspace.cancel();
            return Err(AppError::Cancelled("Render cancelled by user".into()));
        }

        workspace.complete();

        let final_jobs = { jobs_arc.lock().await.clone() };
        Self::write_timestamp_artifact(&pipeline_arc.app, &final_jobs).await;
        Self::emit_final_summary(&pipeline_arc.app, &final_jobs, total_jobs);
        Ok(())
    }

    /// Write the combined `all_timestamps.txt` artifact. Best-effort: failures
    /// emit a warning but never fail the render.
    async fn write_timestamp_artifact(app: &AppHandle, final_jobs: &[RenderJob]) {
        if final_jobs.is_empty() {
            return;
        }
        let mut all_timestamps = Vec::new();
        for job in final_jobs {
            if !job.timestamps.is_empty() {
                all_timestamps.extend(job.timestamps.clone());
                all_timestamps.push("".into());
            }
        }
        let parent_opt = final_jobs
            .first()
            .map(|j| &j.video.output_path)
            .and_then(|p| Path::new(p).parent());
        if let Some(parent) = parent_opt.filter(|_| !all_timestamps.is_empty()) {
            let combined_path = parent.join("all_timestamps.txt");
            let contents = all_timestamps.join("\n").into_bytes();
            if let Err(error) = fs::atomic_write(&combined_path, contents).await {
                event::emit(
                    app,
                    PipelineEvent::Log {
                        level: "warn".into(),
                        message: format!(
                            "Render completed, but all_timestamps.txt could not be written: {}",
                            error
                        ),
                    },
                );
                crate::utils::logger::log_line(&format!(
                    "Timestamp artifact write failed for '{}': {}",
                    combined_path.display(),
                    error
                ));
            }
        }
    }

    fn emit_final_summary(app: &AppHandle, final_jobs: &[RenderJob], total_jobs: usize) {
        let failed = final_jobs
            .iter()
            .filter(|j| j.state == JobState::Error)
            .count();
        let completed = final_jobs
            .iter()
            .filter(|j| j.state == JobState::Done)
            .count();
        event::emit(
            app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!(
                    "Render finished: {}/{} completed, {} failed",
                    completed, total_jobs, failed
                ),
            },
        );
        event::emit(
            app,
            PipelineEvent::Done {
                completed,
                total: total_jobs,
                failed,
            },
        );
    }

    /// Load jobs from the resume state file, falling back to a fresh batch on
    /// any validation/IO failure (quarantining the bad file). Extracted from
    /// `execute()` so the orchestrator stays readable.
    #[allow(clippy::too_many_arguments)]
    async fn load_resume_or_fresh(
        &self,
        resume: bool,
        state_path: &Path,
        video_files: &[String],
        safe_prefix: &str,
        output_dir: &Path,
        output_ext: &str,
        input_roots: &[std::path::PathBuf],
        thumb_dir: &Path,
        workspace: &mut WorkspaceGuard,
        render_timestamp: u64,
    ) -> Result<Vec<RenderJob>, AppError> {
        if !(resume && state_path.exists()) {
            return Ok(self.create_initial_jobs(video_files, safe_prefix, output_dir, output_ext));
        }
        let content = match tokio::fs::read_to_string(state_path).await {
            Ok(c) => c,
            Err(error) => {
                event::emit(
                    &self.app,
                    PipelineEvent::Log {
                        level: "warn".into(),
                        message: format!("Unable to read saved render state: {}", error),
                    },
                );
                return Ok(self.create_initial_jobs(
                    video_files,
                    safe_prefix,
                    output_dir,
                    output_ext,
                ));
            }
        };
        let mut saved_jobs: Vec<RenderJob> = match serde_json::from_str(&content) {
            Ok(j) => j,
            Err(error) => {
                event::emit(
                    &self.app,
                    PipelineEvent::Log {
                        level: "warn".into(),
                        message: format!(
                            "Saved render state is invalid ({}); quarantining it and starting a fresh batch.",
                            error
                        ),
                    },
                );
                if !quarantine_state_file(state_path, render_timestamp) {
                    workspace.cancel();
                    return Err(AppError::Pipeline(
                        "Invalid render state could not be quarantined".into(),
                    ));
                }
                return Ok(self.create_initial_jobs(
                    video_files,
                    safe_prefix,
                    output_dir,
                    output_ext,
                ));
            }
        };
        if let Err(error) = crate::validation::validate_resumed_jobs(
            &saved_jobs,
            output_dir,
            input_roots,
            thumb_dir,
        ) {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!(
                        "Saved render state failed validation ({}); quarantining it and starting a fresh batch.",
                        error
                    ),
                },
            );
            if !quarantine_state_file(state_path, render_timestamp) {
                workspace.cancel();
                return Err(AppError::Pipeline(
                    "Invalid render state could not be quarantined".into(),
                ));
            }
            return Ok(self.create_initial_jobs(video_files, safe_prefix, output_dir, output_ext));
        }
        for j in &mut saved_jobs {
            if j.state != JobState::Done {
                j.state = JobState::Pending;
                j.progress_percent = 0;
                j.current_step = "Pending".into();
                j.error = None;
            }
        }
        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: "Resuming previous render state...".into(),
            },
        );
        Ok(saved_jobs)
    }

    fn create_initial_jobs(
        &self,
        video_files: &[String],
        safe_prefix: &str,
        output_dir: &Path,
        output_ext: &str,
    ) -> Vec<RenderJob> {
        let mut jobs = Vec::new();
        // Include a process-local high-resolution nonce in every fresh batch
        // name. Second-level timestamps alone collide when a user starts a
        // second render immediately after the first one finishes.
        let wall_clock = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let ts = format!("{}_{}_{}", wall_clock, std::process::id(), nonce);
        for (idx, path_str) in video_files.iter().enumerate() {
            let input_path = Path::new(path_str);
            let name = input_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let stem = Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown");
            let ext = output_ext;
            let unique_name = format!("{}_{}_{}.{}", stem, ts, idx, ext);
            let output_name = if safe_prefix.is_empty() {
                unique_name
            } else {
                format!("{}_{}", safe_prefix, unique_name)
            };
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
}
