//! Decision logic extracted from [`Pipeline::execute`]'s main job loop.
//!
//! Each function captures a specific branch in the loop without depending
//! on FFmpeg, filesystem, or Tauri — they can be tested directly.
//!
//! The [`JobLoopRunner`] trait is the single injection point for FFmpeg
//! calls; a mock implementation lets us test the full loop's control-flow
//! (cancel mid-batch, pause→resume race, error propagation) without
//! spawning real subprocesses.

use crate::error::AppError;
use crate::models::job::{JobState, RenderJob};
use std::future::Future;
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

/// Translate a [`job_processor::process_single_job`] result into the next
/// loop step, taking the current pause state into account.
///
/// - `Ok(())` → [`LoopAction::Advance`]
/// - `Err(AppError::Cancelled)` → [`LoopAction::Break`]
/// - `Err(AppError::Paused)` when still paused → [`LoopAction::Break`]
/// - `Err(AppError::Paused)` when resumed (race) → [`LoopAction::Retry`]
/// - Any other error → [`LoopAction::Advance`] (error is written to the job before calling this)
pub(crate) fn decide_next_action(
    result: &Result<(), AppError>,
    is_paused: bool,
) -> LoopAction {
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

// ── Runner trait ───────────────────────────────────────────────────────

/// Minimal abstraction over [`job_processor::process_single_job`].
///
/// The real implementation delegates directly to `process_single_job`; a
/// `MockRunner` in tests can return pre-baked results to exercise every
/// branch of the job loop without spawning FFmpeg.
#[allow(dead_code)] // Only exercised by tests; kept for future loop injection via trait
pub(crate) trait JobLoopRunner: Send + Sync {
    fn run_job(
        &self,
        job: &mut RenderJob,
        idx: usize,
    ) -> impl Future<Output = Result<(), AppError>> + Send;
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
            decide_next_action(
                &Err(AppError::Cancelled("cancelled".into())),
                false,
            ),
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
            decide_next_action(
                &Err(AppError::Pipeline("oops".into())),
                false,
            ),
            LoopAction::Advance,
        );
    }

    // ── MockRunner: full loop simulation ────────────────────────────────

    use std::sync::Mutex;

    /// Test-only runner that returns pre-baked results in sequence.
    struct MockRunner {
        results: Mutex<std::vec::IntoIter<Result<(), AppError>>>,
        called: Mutex<Vec<usize>>,
    }

    impl MockRunner {
        fn new(results: Vec<Result<(), AppError>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter()),
                called: Mutex::new(vec![]),
            }
        }
    }

    impl JobLoopRunner for MockRunner {
        async fn run_job(
            &self,
            _job: &mut RenderJob,
            idx: usize,
        ) -> Result<(), AppError> {
            self.called.lock().unwrap().push(idx);
            self.results
                .lock()
                .unwrap()
                .next()
                .unwrap_or(Ok(()))
        }
    }

    fn make_job(name: &str, state: JobState) -> RenderJob {
        let pct = if state == JobState::Done { 100 } else { 0 };
        let step = format!("{:?}", state);
        RenderJob {
            video: VideoFile {
                name: name.into(),
                input_path: format!("/in/{}", name),
                output_path: format!("/out/{}", name),
                thumbnail_path: None,
            },
            state,
            progress_percent: pct,
            current_step: step,
            error: None,
            timestamps: vec![],
        }
    }

    /// Run a simulated loop over the given jobs with the mock runner.
    /// Each job's `state` is advanced through the loop as if `process_single_job`
    /// had run. Returns (completed_count, error_count, break_reason).
    async fn simulate_loop(
        runner: &MockRunner,
        jobs: &mut [RenderJob],
        should_break_before: impl Fn(usize) -> bool,
    ) -> (usize, usize, Option<String>) {
        let total = jobs.len();
        let mut idx = 0;
        let mut completed = 0;
        let mut errors = 0;

        while idx < total {
            if should_break_before(idx) {
                break;
            }

            if should_skip_job(&jobs[idx]) {
                idx += 1;
                continue;
            }

            let result = runner.run_job(&mut jobs[idx], idx).await;
            match decide_next_action(&result, false) {
                LoopAction::Advance => match result {
                    Ok(()) => {
                        jobs[idx].state = JobState::Done;
                        completed += 1;
                        idx += 1;
                    }
                    Err(e) => {
                        jobs[idx].state = JobState::Error;
                        jobs[idx].error = Some(e.to_string());
                        errors += 1;
                        idx += 1;
                    }
                },
                LoopAction::Break => {
                    return (completed, errors, Some("cancelled".into()));
                }
                LoopAction::Retry => {
                    // Don't advance idx — re-run the same job.
                }
            }
        }

        (completed, errors, None)
    }

    #[tokio::test]
    async fn loop_completes_all_jobs_successfully() {
        let runner = MockRunner::new(vec![Ok(()), Ok(()), Ok(())]);
        let mut jobs = vec![
            make_job("a.mp4", JobState::Pending),
            make_job("b.mp4", JobState::Pending),
            make_job("c.mp4", JobState::Pending),
        ];

        let (completed, errors, reason) =
            simulate_loop(&runner, &mut jobs, |_| false).await;

        assert_eq!(completed, 3);
        assert_eq!(errors, 0);
        assert!(reason.is_none());
        assert_eq!(jobs.iter().filter(|j| j.state == JobState::Done).count(), 3);
        assert_eq!(*runner.called.lock().unwrap(), vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn loop_stops_mid_batch_on_cancel() {
        // First job succeeds, second job returns Cancelled.
        let runner = MockRunner::new(vec![
            Ok(()),
            Err(AppError::Cancelled("stopped".into())),
            Ok(()), // never reached
        ]);
        let mut jobs = vec![
            make_job("a.mp4", JobState::Pending),
            make_job("b.mp4", JobState::Pending),
            make_job("c.mp4", JobState::Pending),
        ];

        let (completed, errors, reason) =
            simulate_loop(&runner, &mut jobs, |_| false).await;

        assert_eq!(completed, 1); // only first job finished
        assert_eq!(errors, 0);
        assert_eq!(reason, Some("cancelled".into()));
        // Job b was never completed (cancelled mid-processing).
        assert_eq!(jobs[0].state, JobState::Done);
        assert_eq!(jobs[1].state, JobState::Pending);
        assert_eq!(jobs[2].state, JobState::Pending);
    }

    #[tokio::test]
    async fn loop_handles_error_job_and_continues() {
        let runner = MockRunner::new(vec![
            Ok(()),
            Err(AppError::Pipeline("broken".into())),
            Ok(()),
        ]);
        let mut jobs = vec![
            make_job("a.mp4", JobState::Pending),
            make_job("b.mp4", JobState::Pending),
            make_job("c.mp4", JobState::Pending),
        ];

        let (completed, errors, reason) =
            simulate_loop(&runner, &mut jobs, |_| false).await;

        assert_eq!(completed, 2);
        assert_eq!(errors, 1);
        assert!(reason.is_none());
        assert_eq!(jobs[0].state, JobState::Done);
        assert_eq!(jobs[1].state, JobState::Error);
        assert_eq!(jobs[2].state, JobState::Done);
    }

    #[tokio::test]
    async fn loop_retries_on_pause_race() {
        // First call: Paused (but already resumed). Second call: OK.
        let runner = MockRunner::new(vec![
            Err(AppError::Paused("paused".into())),
            Ok(()),
            Ok(()),
        ]);
        let mut jobs = vec![
            make_job("a.mp4", JobState::Pending),
            make_job("b.mp4", JobState::Pending),
        ];

        let (completed, errors, reason) =
            simulate_loop(&runner, &mut jobs, |_| false).await;

        assert_eq!(completed, 2);
        assert_eq!(errors, 0);
        assert!(reason.is_none());
        // Called idx 0 twice (first time Paused→retry, second time OK).
        assert_eq!(*runner.called.lock().unwrap(), vec![0, 0, 1]);
    }
}