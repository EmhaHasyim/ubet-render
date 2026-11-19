//! Resume-state loading and initial job construction, split out of
//! `pipeline/mod.rs` so the orchestrator focuses on the job loop.

use super::Pipeline;
use super::workspace_guard::{WorkspaceGuard, quarantine_state_file};
use crate::error::AppError;
use crate::models::job::{JobState, PipelineEvent, RenderJob};
use crate::models::media::VideoFile;
use crate::utils::event;
use std::path::{Path, PathBuf};

/// Borrowed inputs for [`Pipeline::load_resume_or_fresh`], grouped so the
/// loader takes three arguments instead of ten (and needs no
/// `clippy::too_many_arguments` allowance).
pub(super) struct ResumeContext<'a> {
    pub(super) state_path: &'a Path,
    pub(super) video_files: &'a [String],
    pub(super) safe_prefix: &'a str,
    pub(super) output_dir: &'a Path,
    pub(super) output_ext: &'a str,
    pub(super) input_roots: &'a [PathBuf],
    pub(super) thumb_dir: &'a Path,
    pub(super) render_timestamp: u64,
}

impl Pipeline {
    /// Load jobs from the resume state file, falling back to a fresh batch on
    /// any validation/IO failure (quarantining the bad file).
    pub(super) async fn load_resume_or_fresh(
        &self,
        resume: bool,
        ctx: ResumeContext<'_>,
        workspace: &mut WorkspaceGuard,
    ) -> Result<Vec<RenderJob>, AppError> {
        let ResumeContext {
            state_path,
            video_files,
            safe_prefix,
            output_dir,
            output_ext,
            input_roots,
            thumb_dir,
            render_timestamp,
        } = ctx;
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
                        message: format!("Unable to read saved render state: {error}"),
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
                            "Saved render state is invalid ({error}); quarantining it and starting a fresh batch."
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
                        "Saved render state failed validation ({error}); quarantining it and starting a fresh batch."
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
            let unique_name = format!("{stem}_{ts}_{idx}.{output_ext}");
            let output_name = if safe_prefix.is_empty() {
                unique_name
            } else {
                format!("{safe_prefix}_{unique_name}")
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
