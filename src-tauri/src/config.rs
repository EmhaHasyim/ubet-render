use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub directories: Directories,
    pub metadata: Metadata,
    pub target: Target,
    pub video: VideoSettings,
    pub audio: AudioSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Directories {
    pub video: String,
    pub audio: String,
    pub output: String,
    pub cache: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub channel_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub min_duration_sec: u64,
    pub padding_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub bitrate_target: String,
    pub bitrate_max: String,
    pub fps: u32,
    pub encoder: String,
    pub preset: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub songs_per_playlist: usize,
    pub concurrent_prep: usize,
    pub bitrate: String,
    pub sample_rate: u32,
    pub loudnorm_params: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        // Cache disimpan di folder sementara sistem agar tidak mengganggu hot reload Tauri
        let cache_dir = std::env::temp_dir()
            .join("ubet-render")
            .join("cache")
            .to_string_lossy()
            .to_string();

        Self {
            directories: Directories {
                video: "./videos".into(),
                audio: "./audios".into(),
                output: "./outputs".into(),
                cache: cache_dir,
            },
            metadata: Metadata {
                channel_prefix: "Ubet Render".into(),
            },
            target: Target {
                min_duration_sec: 3600,
                padding_sec: 10,
            },
            video: VideoSettings {
                bitrate_target: "4000k".into(),
                bitrate_max: "5000k".into(),
                fps: 30,
                encoder: "av1_nvenc".into(),
                preset: "p6".into(),
            },
            audio: AudioSettings {
                songs_per_playlist: 9,
                concurrent_prep: 5,
                bitrate: "192k".into(),
                sample_rate: 44100,
                loudnorm_params: "I=-14:LRA=11:TP=-1".into(),
            },
        }
    }
}
