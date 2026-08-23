use serde::{Deserialize, Serialize};

// NOTE: `deny_unknown_fields` is intentionally NOT used here, matching the
// policy on `AppConfig` (see config.rs).  This allows forward compatibility —
// when a future frontend version sends new fields, older backends can still
// accept the IPC call and will simply ignore unknown fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideConfig {
    pub video_source: Option<MediaSource>,
    pub audio_source: Option<MediaSource>,
    pub output_path: Option<String>,
    pub songs_per_playlist: Option<usize>,
    pub min_duration_hours: Option<f64>,
    pub loop_count: Option<usize>,
    pub encoder: Option<String>,
    pub output_prefix: Option<String>,
    pub maxrate: Option<String>,
    pub use_pingpong: Option<bool>,
    pub audio_mode: Option<String>,
    pub embed_chapters: Option<bool>,
    pub output_format: Option<String>,
    /// When true the intermediate re-encode step is bypassed entirely —
    /// the source video is stream-copied directly into the final output
    /// regardless of codec. An explicit opt-in; false preserves ping-pong.
    pub skip_intermediate_on_codec_match: Option<bool>,
}

// NOTE: `deny_unknown_fields` is intentionally NOT used here, matching the
// policy on `AppConfig` and `OverrideConfig`.  This allows forward
// compatibility — when a future frontend version sends new fields inside a
// MediaSource payload, older backends can still deserialize it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaSource {
    #[serde(rename = "folder")]
    Folder { path: String },
    #[serde(rename = "files")]
    Files { paths: Vec<String> },
}
