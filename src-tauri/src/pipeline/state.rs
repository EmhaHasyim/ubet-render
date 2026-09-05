use crate::error::AppError;
use crate::models::job::{JobProgress, JobState, PipelineEvent, RenderJob};
use crate::utils::event;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

/// Minimum gap (ms) between coalesced progress emissions sent to the frontend.
/// ffmpeg emits progress lines several times per second per concurrent job, so
/// without throttling the pipeline would clone + serialize the entire job list
/// on every line.
const EMIT_INTERVAL_MS: u64 = 120;

/// Manages render-state persistence and progress emission for the pipeline.
pub struct StateManager {
    last_save_sec: AtomicU64,
    last_emit_ms: AtomicU64,
}

impl StateManager {
    pub fn new() -> Self {
        Self {
            last_save_sec: AtomicU64::new(0),
            last_emit_ms: AtomicU64::new(0),
        }
    }

    pub async fn save_state(&self, state_path: &Path, jobs: &[RenderJob]) -> Result<(), AppError> {
        self.save_state_jobs(state_path, jobs).await
    }

    /// Serialize jobs to the state file atomically (tmp file + replace),
    /// off the async executor. `RenderJob` itself derives `Serialize`.
    async fn save_state_jobs(
        &self,
        state_path: &Path,
        jobs: &[RenderJob],
    ) -> Result<(), AppError> {
        let json = serde_json::to_string(jobs).map_err(|e| AppError::Pipeline(e.to_string()))?;
        crate::utils::fs::atomic_write(state_path, json.into_bytes())
            .await
            .map_err(AppError::Io)
    }

    pub async fn save_state_from_arc(
        &self,
        state_path: &Path,
        jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
    ) -> Result<(), AppError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let last = self.last_save_sec.load(Ordering::Acquire);
        if now.saturating_sub(last) < 2 {
            return Ok(());
        }
        // Use compare_exchange to avoid double-save when two concurrent callers
        // race through the guard above. Only one caller succeeds; the other
        // bails out, avoiding a redundant disk write.
        if self
            .last_save_sec
            .compare_exchange(last, now, Ordering::SeqCst, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        // Clone the job list while holding the lock, then release it before
        // the blocking file write to avoid stalling progress updates.
        let jobs = jobs_arc.lock().await.clone();
        self.save_state_jobs(state_path, &jobs).await
    }

    pub async fn emit_progress_from_arc(
        &self,
        app: &AppHandle,
        jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
    ) {
        let jobs = jobs_arc.lock().await;
        let total = jobs.len();
        let completed = jobs.iter().filter(|j| j.state == JobState::Done).count();
        // Send a compact per-job payload instead of cloning the full `RenderJob`
        // (which would also drag along each job's `timestamps` vector). Only the
        // fields the dashboard needs for the table + progress bar are included.
        let progress: Vec<JobProgress> = jobs
            .iter()
            .enumerate()
            .map(|(i, j)| JobProgress {
                index: i,
                state: j.state.clone(),
                progress_percent: j.progress_percent,
                current_step: j.current_step.clone(),
                name: j.video.name.clone(),
                output_path: j.video.output_path.clone(),
                thumbnail_path: j.video.thumbnail_path.clone(),
            })
            .collect();
        drop(jobs);
        event::emit(
            app,
            PipelineEvent::Progress {
                total,
                completed,
                jobs: progress,
            },
        );
    }

    /// Like [`Self::emit_progress_from_arc`] but coalesces bursts: at most one
    /// emission per [`EMIT_INTERVAL_MS`] window. Used for the high-frequency,
    /// per-frame ffmpeg progress updates so we don't clone + serialize the job
    /// list dozens of times per second.
    pub async fn emit_progress_throttled(
        &self,
        app: &AppHandle,
        jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
    ) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let last = self.last_emit_ms.load(Ordering::Acquire);
        if now_ms.saturating_sub(last) < EMIT_INTERVAL_MS {
            return;
        }
        if self
            .last_emit_ms
            .compare_exchange(last, now_ms, Ordering::SeqCst, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        self.emit_progress_from_arc(app, jobs_arc).await;
    }
}

impl Default for StateManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::job::JobState;
    use crate::models::media::VideoFile;

    #[tokio::test]
    async fn save_state_preserves_completed_job_timestamps_for_resume() {
        let state_path = std::env::temp_dir().join(format!(
            "ubet_state_timestamps_{}_{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let jobs = vec![RenderJob {
            video: VideoFile {
                name: "clip.mp4".into(),
                input_path: "input/clip.mp4".into(),
                output_path: "output/clip.mp4".into(),
                thumbnail_path: None,
            },
            state: JobState::Done,
            progress_percent: 100,
            current_step: "Done".into(),
            error: None,
            timestamps: vec!["00:00 - Song".into(), "00:03 - Looping".into()],
        }];

        let jobs_arc = Arc::new(tokio::sync::Mutex::new(jobs.clone()));
        StateManager::new()
            .save_state_from_arc(&state_path, &jobs_arc)
            .await
            .unwrap();
        let saved = std::fs::read_to_string(&state_path).unwrap();
        let restored: Vec<RenderJob> = serde_json::from_str(&saved).unwrap();

        assert_eq!(restored[0].timestamps, jobs[0].timestamps);
        let _ = std::fs::remove_file(state_path);
    }
}
