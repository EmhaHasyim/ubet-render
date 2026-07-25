use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// NOTE: `deny_unknown_fields` is intentionally NOT used on these config
// structs.  Removing it allows forward compatibility — when a future app
// version adds new fields to the persisted config, older versions can still
// load the file (unknown fields are silently ignored by serde).  All fields
// have sensible defaults via `#[serde(default)]` or `Default::default()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub directories: Directories,
    pub metadata: Metadata,
    pub target: Target,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub embed_chapters: bool,
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
    pub audio_mode: String,
}

impl AppConfig {
    /// Path to the persisted config file (`config.json` in the app config
    /// directory). Uses the `dirs` platform convention; falls back to
    /// `./.ubet-render-config` when the platform dir cannot be determined.
    pub fn config_path() -> PathBuf {
        let base = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ubet-render");
        base.join("config.json")
    }

    /// Load configuration from disk, falling back to defaults when the file
    /// doesn't exist or can't be parsed.
    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(cfg) => return cfg,
                    Err(e) => {
                        crate::utils::logger::log_line(&format!(
                            "Failed to parse config at '{}': {}. Using defaults.",
                            path.display(),
                            e
                        ));
                    }
                },
                Err(e) => {
                    crate::utils::logger::log_line(&format!(
                        "Failed to read config at '{}': {}. Using defaults.",
                        path.display(),
                        e
                    ));
                }
            }
        }
        Self::default()
    }

    /// Persist the current configuration to disk. Creates parent directories
    /// as needed and performs an atomic write via a temp file + rename.
    /// Directory paths are canonicalized before persisting so relative paths
    /// (e.g. \"./outputs\") never shift meaning when the process CWD changes
    /// between sessions.
    pub fn save(&self) -> Result<(), std::io::Error> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        // Canonicalize directory paths so persisted config always stores
        // absolute paths — prevents relative-path drift across sessions.
        let mut canonicalized = self.clone();
        canonicalized.directories.video =
            crate::utils::fs::to_absolute(std::path::Path::new(&self.directories.video))
                .to_string_lossy()
                .to_string();
        canonicalized.directories.audio =
            crate::utils::fs::to_absolute(std::path::Path::new(&self.directories.audio))
                .to_string_lossy()
                .to_string();
        canonicalized.directories.output =
            crate::utils::fs::to_absolute(std::path::Path::new(&self.directories.output))
                .to_string_lossy()
                .to_string();
        canonicalized.directories.cache =
            crate::utils::fs::to_absolute(std::path::Path::new(&self.directories.cache))
                .to_string_lossy()
                .to_string();
        let json = serde_json::to_string_pretty(&canonicalized)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        let cache_dir = crate::utils::fs::ubet_temp_dir()
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
                encoder: "av1_nvenc".into(),
                preset: "p6".into(),
            },
            audio: AudioSettings {
                songs_per_playlist: 9,
                concurrent_prep: 5,
                bitrate: "192k".into(),
                sample_rate: 44100,
                loudnorm_params: "I=-14:LRA=11:TP=-1".into(),
                audio_mode: "original".into(),
            },
            embed_chapters: true,
        }
    }
}
