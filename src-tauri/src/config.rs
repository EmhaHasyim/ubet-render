use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// NOTE: `deny_unknown_fields` is intentionally NOT used on these config
// structs.  Removing it allows forward compatibility — when a future app
// version adds new fields to the persisted config, older versions can still
// load the file (unknown fields are silently ignored by serde).  All fields
// have sensible defaults via `#[serde(default)]` or `Default::default()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub directories: Directories,
    pub metadata: Metadata,
    pub target: Target,
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub embed_chapters: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Directories {
    pub video: String,
    pub audio: String,
    pub output: String,
    pub cache: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Metadata {
    pub channel_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    pub min_duration_sec: u64,
    pub padding_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoSettings {
    pub bitrate_target: String,
    pub bitrate_max: String,
    pub encoder: String,
    pub preset: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    pub songs_per_playlist: usize,
    pub concurrent_prep: usize,
    pub bitrate: String,
    pub sample_rate: u32,
    pub loudnorm_params: String,
    pub audio_mode: String,
}

impl Default for Directories {
    fn default() -> Self {
        Self {
            video: "./videos".into(),
            audio: "./audios".into(),
            output: "./outputs".into(),
            cache: crate::utils::fs::ubet_temp_dir()
                .join("cache")
                .to_string_lossy()
                .to_string(),
        }
    }
}

impl Default for Metadata {
    fn default() -> Self {
        Self {
            channel_prefix: "Ubet Render".into(),
        }
    }
}

impl Default for Target {
    fn default() -> Self {
        Self {
            min_duration_sec: 3600,
            padding_sec: 10,
        }
    }
}

impl Default for VideoSettings {
    fn default() -> Self {
        Self {
            bitrate_target: "4000k".into(),
            bitrate_max: "5000k".into(),
            encoder: "av1_nvenc".into(),
            preset: "p6".into(),
        }
    }
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            songs_per_playlist: 9,
            concurrent_prep: 5,
            bitrate: "192k".into(),
            sample_rate: 44100,
            loudnorm_params: "I=-14:LRA=11:TP=-1".into(),
            audio_mode: "original".into(),
        }
    }
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

    /// Move an invalid persisted config aside instead of repeatedly failing
    /// on every startup. The original file is preserved for diagnosis.
    fn quarantine_invalid(path: &std::path::Path) {
        let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let backup = path.with_file_name(format!("config.invalid.{}.{}.json", stamp, nonce));
        match std::fs::rename(path, &backup) {
            Ok(()) => crate::utils::logger::log_line(&format!(
                "Moved invalid config '{}' to '{}'.",
                path.display(),
                backup.display()
            )),
            Err(error) => crate::utils::logger::log_line(&format!(
                "Could not quarantine invalid config '{}': {}",
                path.display(),
                error
            )),
        }
    }

    /// Load configuration from disk, falling back to defaults when the file
    /// doesn't exist, cannot be parsed, or fails backend validation.
    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<Self>(&content) {
                    Ok(cfg) => {
                        if crate::validation::validate_app_config(&cfg).is_ok() {
                            return cfg;
                        }
                        crate::utils::logger::log_line(&format!(
                            "Config at '{}' failed validation. Using defaults.",
                            path.display()
                        ));
                        Self::quarantine_invalid(&path);
                    }
                    Err(e) => {
                        crate::utils::logger::log_line(&format!(
                            "Failed to parse config at '{}': {}. Using defaults.",
                            path.display(),
                            e
                        ));
                        Self::quarantine_invalid(&path);
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
        let mut file = std::fs::File::create(&tmp)?;
        use std::io::Write;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = crate::utils::fs::atomic_replace(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            directories: Directories::default(),
            metadata: Metadata::default(),
            target: Target::default(),
            video: VideoSettings::default(),
            audio: AudioSettings::default(),
            embed_chapters: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[test]
    fn partial_legacy_config_fills_nested_defaults() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "directories": { "output": "./custom-output" },
                "video": { "encoder": "libx264" },
                "embedChapters": false
            }"#,
        )
        .expect("partial config should deserialize with defaults");

        assert_eq!(config.directories.output, "./custom-output");
        assert_eq!(config.directories.video, "./videos");
        assert_eq!(config.video.encoder, "libx264");
        assert_eq!(config.video.bitrate_target, "4000k");
        assert!(!config.embed_chapters);
        assert_eq!(config.audio.sample_rate, 44_100);
    }

    #[test]
    fn unknown_fields_remain_forward_compatible() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "futureField": true,
                "metadata": { "futureMetadata": "ignored" }
            }"#,
        )
        .expect("unknown fields should be ignored");

        assert_eq!(config.metadata.channel_prefix, "Ubet Render");
        assert!(config.embed_chapters);
    }
}
