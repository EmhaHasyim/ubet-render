//! Decision logic extracted from [`Pipeline::execute`]'s main job loop.
//!
//! Each function captures a specific branch in the loop without depending
//! on FFmpeg, filesystem, or Tauri — they can be tested directly.

use crate::error::AppError;
use crate::models::job::{JobState, RenderJob};
use std::path::Path;

// ── Pure decision functions ────────────────────────────────────────────

/// Action the job loop should take after processing one job.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LoopAction {
    /// Move to the next job index.
    Advance,
    /// Retry the current job (pause→quick-resume race).
    Retry,
    /// Exit the loop (cancelled).
    Break,
}

/// Determine whether a job should be skipped during resume. A job is skipped
/// when its output file already exists AND its state is Done — this means the
/// previous run completed it before being paused / cancelled.
pub(crate) fn should_skip_job(job: &RenderJob) -> bool {
    Path::new(&job.video.output_path).exists() && job.state == JobState::Done
}

/// Shared milestone granularity: every 10 jobs for large batches, every 25%
/// for small ones (≤20). Minimum step of 1 so division never panics.
/// Single source of truth for `pipeline/mod.rs` and `audio_pool.rs`.
pub(crate) fn milestone_step(total: usize) -> usize {
    if total <= 20 { (total / 4).max(1) } else { 10 }
}

/// Returns `true` when crossing into a new milestone band (or finishing).
/// Replaces duplicated `band > last_milestone || completed == total` checks.
pub(crate) fn is_milestone(completed: usize, total: usize, last: usize, step: usize) -> bool {
    let band = completed / step.max(1);
    band > last || completed == total
}

/// Band index for `completed` (used to update `last_milestone`).
pub(crate) fn milestone_band(completed: usize, step: usize) -> usize {
    completed / step.max(1)
}

/// Translate a [`job_processor::process_single_job`] result into the next
/// loop step, taking the current pause state into account.
///
/// - `Ok(())` → [`LoopAction::Advance`]
/// - `Err(AppError::Cancelled)` → [`LoopAction::Break`]
/// - `Err(AppError::Paused)` when still paused → [`LoopAction::Break`]
/// - `Err(AppError::Paused)` when resumed (race) → [`LoopAction::Retry`]
/// - Any other error → [`LoopAction::Advance`] (error is written to the job before calling this)
pub(crate) fn decide_next_action(result: &Result<(), AppError>, is_paused: bool) -> LoopAction {
    match result {
        Ok(()) => LoopAction::Advance,
        Err(AppError::Cancelled(_)) => LoopAction::Break,
        Err(AppError::Paused(_)) => {
            if is_paused {
                LoopAction::Break
            } else {
                // Resumed mid-teardown — retry the same job.
                LoopAction::Retry
            }
        }
        Err(_) => LoopAction::Advance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::media::VideoFile;
    use std::io::Write;

    // ── should_skip_job ────────────────────────────────────────────────

    #[test]
    fn skip_job_done_with_existing_output() {
        let tmp = std::env::temp_dir().join(format!("ubet_test_skip_{}.mp4", std::process::id()));
        let mut f = std::fs::File::create(&tmp).unwrap();
        f.write_all(b"fake").unwrap();
        drop(f);

        let job = RenderJob {
            video: VideoFile {
                name: "test.mp4".into(),
                input_path: "/in/test.mp4".into(),
                output_path: tmp.to_string_lossy().to_string(),
                thumbnail_path: None,
            },
            state: JobState::Done,
            progress_percent: 100,
            current_step: "Done".into(),
            error: None,
            timestamps: vec![],
        };
        assert!(should_skip_job(&job));
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn dont_skip_pending_job_even_if_output_exists() {
        let tmp = std::env::temp_dir().join(format!("ubet_test_noskip_{}.mp4", std::process::id()));
        let _ = std::fs::File::create(&tmp);

        let job = RenderJob {
            video: VideoFile {
                name: "test.mp4".into(),
                input_path: "/in/test.mp4".into(),
                output_path: tmp.to_string_lossy().to_string(),
                thumbnail_path: None,
            },
            state: JobState::Pending,
            progress_percent: 0,
            current_step: "Pending".into(),
            error: None,
            timestamps: vec![],
        };
        assert!(!should_skip_job(&job));
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn dont_skip_done_job_without_existing_output() {
        let job = RenderJob {
            video: VideoFile {
                name: "test.mp4".into(),
                input_path: "/in/test.mp4".into(),
                output_path: "/out/nonexistent.mp4".into(),
                thumbnail_path: None,
            },
            state: JobState::Done,
            progress_percent: 100,
            current_step: "Done".into(),
            error: None,
            timestamps: vec![],
        };
        assert!(!should_skip_job(&job));
    }

    #[test]
    fn dont_skip_error_job() {
        let job = RenderJob {
            video: VideoFile {
                name: "test.mp4".into(),
                input_path: "/in/test.mp4".into(),
                output_path: "/out/err.mp4".into(),
                thumbnail_path: None,
            },
            state: JobState::Error,
            progress_percent: 0,
            current_step: "Error".into(),
            error: Some("boom".into()),
            timestamps: vec![],
        };
        assert!(!should_skip_job(&job));
    }

    // ── decide_next_action ─────────────────────────────────────────────

    #[test]
    fn ok_result_advances() {
        assert_eq!(decide_next_action(&Ok(()), false), LoopAction::Advance);
    }

    #[test]
    fn cancelled_result_breaks() {
        assert_eq!(
            decide_next_action(&Err(AppError::Cancelled("cancelled".into())), false,),
            LoopAction::Break,
        );
    }

    #[test]
    fn paused_result_when_still_paused_breaks() {
        assert_eq!(
            decide_next_action(&Err(AppError::Paused("paused".into())), true),
            LoopAction::Break,
        );
    }

    #[test]
    fn paused_result_when_resumed_retries() {
        // pause→quick-resume race: the job returned Paused but the user
        // already clicked Resume — retry the same job instead of exiting.
        assert_eq!(
            decide_next_action(&Err(AppError::Paused("paused".into())), false),
            LoopAction::Retry,
        );
    }

    #[test]
    fn generic_error_advances() {
        assert_eq!(
            decide_next_action(&Err(AppError::Pipeline("oops".into())), false,),
            LoopAction::Advance,
        );
    }
}
