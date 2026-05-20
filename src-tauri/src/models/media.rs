use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedAudio {
    pub path: String,
    pub duration: f64,
    pub original_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFile {
    pub name: String,
    pub input_path: String,
    pub output_path: String,
    pub thumbnail_path: Option<String>,
}
