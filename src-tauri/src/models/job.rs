use super::media::VideoFile;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Pending,
    Processing,
    Done,
    Error,
}

/// Lightweight per-job progress payload sent over the Tauri event channel.
///
/// Unlike [`RenderJob`], this carries only what the dashboard needs to
/// render the jobs table and the overall progress bar, so the pipeline can
/// emit it on every progress tick without serializing the (potentially large)
/// `timestamps` vector or cloning the full video/audio descriptors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub index: usize,
    pub state: JobState,
    pub progress_percent: u8,
    pub current_step: String,
    pub name: String,
    pub output_path: String,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderJob {
    pub video: VideoFile,
    pub state: JobState,
    pub progress_percent: u8,
    pub current_step: String,
    pub error: Option<String>,
    #[serde(default)]
    pub timestamps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum PipelineEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        total: usize,
        completed: usize,
        jobs: Vec<JobProgress>,
    },
    Log {
        level: String,
        message: String,
    },
    Done {
        completed: usize,
        total: usize,
        failed: usize,
    },
    Cancelled(String),
    Paused,
    FatalError(String),
    /// Live ffmpeg render statistics (speed / bitrate / fps) parsed from the
    /// encoder's stderr. Surfaced to the UI so the dashboard can show a
    /// real-time render readout instead of only the coarse progress bar.
    #[serde(rename_all = "camelCase")]
    Stats {
        speed: f64,
        bitrate_kbps: f64,
        fps: f64,
    },
}

/// Live ffmpeg render statistics parsed from stderr (speed / bitrate / fps).
///
/// This is the transport type sent from the ffmpeg sidecar task to the
/// pipeline's stats-forwarder task over an `mpsc` channel; the forwarder then
/// re-emits it as a [`PipelineEvent::Stats`]. It deliberately carries no
/// `Serialize`/`Deserialize` because it never crosses the Tauri IPC boundary
/// in this form.
#[derive(Debug, Clone)]
pub struct RenderStats {
    pub speed: f64,
    pub bitrate_kbps: f64,
    pub fps: f64,
}
