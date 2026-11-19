//! Decision logic extracted from [`Pipeline::execute`]'s main job loop.
//!
//! Each function captures a specific branch in the loop without depending
//! on `FFmpeg` or Tauri — they can be tested directly.

use crate::error::AppError;
use crate::models::job::JobState;

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
/// previous run completed it before being paused / cancelled. The metadata
/// check is async so the job loop never blocks a Tokio worker on disk I/O.
pub(crate) async fn should_skip_job(state: &JobState, output_path: &str) -> bool {
    *state == JobState::Done && tokio::fs::metadata(output_path).await.is_ok()
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
        Err(AppError::Cancelled(_)) => LoopAction::Break,
        Err(AppError::Paused(_)) => {
            if is_paused {
                LoopAction::Break
            } else {
                // Resumed mid-teardown — retry the same job.
                LoopAction::Retry
            }
        }
        Ok(()) | Err(_) => LoopAction::Advance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_media(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "ubet_test_{name}_{}_{}.mp4",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ))
    }

    // ── should_skip_job ────────────────────────────────────────────────

    #[tokio::test]
    async fn skip_job_done_with_existing_output() {
        let tmp = temp_media("skip");
        let mut file = std::fs::File::create(&tmp).unwrap();
        file.write_all(b"fake").unwrap();
        drop(file);

        assert!(should_skip_job(&JobState::Done, &tmp.to_string_lossy()).await);
        let _ = std::fs::remove_file(&tmp);
    }

    #[tokio::test]
    async fn dont_skip_pending_job_even_if_output_exists() {
        let tmp = temp_media("noskip");
        let _ = std::fs::File::create(&tmp);

        assert!(!should_skip_job(&JobState::Pending, &tmp.to_string_lossy()).await);
        let _ = std::fs::remove_file(&tmp);
    }

    #[tokio::test]
    async fn dont_skip_done_job_without_existing_output() {
        let missing = std::env::temp_dir().join("ubet_test_missing_output_does_not_exist.mp4");
        assert!(!should_skip_job(&JobState::Done, &missing.to_string_lossy()).await);
    }

    #[tokio::test]
    async fn dont_skip_error_job() {
        let tmp = temp_media("error");
        let _ = std::fs::File::create(&tmp);

        assert!(!should_skip_job(&JobState::Error, &tmp.to_string_lossy()).await);
        let _ = std::fs::remove_file(&tmp);
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
