use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideConfig {
    pub video_source: Option<MediaSource>,
    pub audio_source: Option<MediaSource>,
    pub output_path: Option<String>,
    pub songs_per_playlist: Option<usize>,
    pub min_duration_hours: Option<f64>,
    pub encoder: Option<String>,
    pub output_prefix: Option<String>,
    pub maxrate: Option<String>,
    pub use_pingpong: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaSource {
    #[serde(rename = "folder")]
    Folder { path: String },
    #[serde(rename = "files")]
    Files { paths: Vec<String> },
}
