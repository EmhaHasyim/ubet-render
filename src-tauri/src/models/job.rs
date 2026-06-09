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
    Progress {
        total: usize,
        completed: usize,
        current_video: String,
        jobs: Vec<RenderJob>,
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
    FatalError(String),
}
