use crate::error::AppError;
use crate::models::settings::{MediaSource, OverrideConfig};
use std::path::{Path, PathBuf};

const MAX_BITRATE_K: u32 = 50000;
const MIN_BITRATE_K: u32 = 100;
const MAX_SONGS_PER_PLAYLIST: usize = 100;
const MIN_SONGS_PER_PLAYLIST: usize = 1;
const MAX_DURATION_HOURS: f64 = 24.0;
const MIN_DURATION_HOURS: f64 = 0.1;
const MAX_CONCURRENT_JOBS: usize = 32;
const MIN_CONCURRENT_JOBS: usize = 1;
const MAX_WATERMARK_OPACITY: f32 = 1.0;
const MIN_WATERMARK_OPACITY: f32 = 0.0;
const VALID_ENCODERS: &[&str] = &[
    "libx264", "h264_nvenc", "h264_amf", "h264_qsv",
    "libx265", "hevc_nvenc", "hevc_amf", "hevc_qsv",
    "av1_nvenc", "av1_amf", "av1_qsv", "libsvtav1",
];
const MAX_PREFIX_LEN: usize = 100;
const MAX_PATH_LEN: usize = 4096;

fn sanitize_path(path: &str) -> Result<PathBuf, AppError> {
    if path.len() > MAX_PATH_LEN {
        return Err(AppError::Pipeline(format!("Path too long: {} > {}", path.len(), MAX_PATH_LEN)));
    }
    if path.contains('\0') {
        return Err(AppError::Pipeline("Path contains null byte".into()));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(AppError::Pipeline("Path contains control characters".into()));
    }
    let path = Path::new(path);
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::Pipeline("Path traversal detected".into()));
    }
    if cfg!(windows) && path.to_string_lossy().starts_with("\\\\") {
        return Err(AppError::Pipeline("UNC paths are not allowed".into()));
    }
    Ok(path.to_path_buf())
}

#[allow(dead_code)]
fn resolve_and_validate_path(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, AppError> {
    let canonical = path.canonicalize().map_err(|e| AppError::Pipeline(format!("Failed to resolve path: {}", e)))?;
    let is_allowed = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !is_allowed {
        return Err(AppError::Pipeline("Path resolves outside allowed directories".into()));
    }
    Ok(canonical)
}

fn validate_media_source(source: &MediaSource, media_type: &str) -> Result<(), AppError> {
    match source {
        MediaSource::Folder { path } => {
            let _ = sanitize_path(path)?;
            if !Path::new(path).exists() {
                return Err(AppError::Pipeline(format!("{} folder does not exist: {}", media_type, path)));
            }
        }
        MediaSource::Files { paths } => {
            if paths.is_empty() {
                return Err(AppError::Pipeline(format!("{} files list is empty", media_type)));
            }
            for p in paths {
                let _ = sanitize_path(p)?;
                if !Path::new(p).exists() {
                    return Err(AppError::Pipeline(format!("{} file does not exist: {}", media_type, p)));
                }
            }
        }
    }
    Ok(())
}

fn validate_bitrate(bitrate: &str) -> Result<u32, AppError> {
    let normalized = bitrate.trim().to_ascii_lowercase();
    let number = normalized.strip_suffix('k').unwrap_or(&normalized);
    let k = number.parse::<u32>().map_err(|_| AppError::Pipeline(format!("Invalid bitrate format: {}", bitrate)))?;
    if !(MIN_BITRATE_K..=MAX_BITRATE_K).contains(&k) {
        return Err(AppError::Pipeline(format!("Bitrate {}k out of range ({}-{}k)", k, MIN_BITRATE_K, MAX_BITRATE_K)));
    }
    Ok(k)
}

pub fn validate_override_config(overrides: &OverrideConfig) -> Result<(), AppError> {
    if let Some(ref video_source) = overrides.video_source {
        validate_media_source(video_source, "Video")?;
    }
    if let Some(ref audio_source) = overrides.audio_source {
        validate_media_source(audio_source, "Audio")?;
    }
    if let Some(ref output_path) = overrides.output_path {
        let _ = sanitize_path(output_path)?;
    }
    if let Some(songs) = overrides.songs_per_playlist
        && (!(MIN_SONGS_PER_PLAYLIST..=MAX_SONGS_PER_PLAYLIST).contains(&songs)) {
            return Err(AppError::Pipeline(format!("Songs per playlist {} out of range ({}-{})", songs, MIN_SONGS_PER_PLAYLIST, MAX_SONGS_PER_PLAYLIST)));
        }
    if let Some(hours) = overrides.min_duration_hours
        && (!(MIN_DURATION_HOURS..=MAX_DURATION_HOURS).contains(&hours)) {
            return Err(AppError::Pipeline(format!("Min duration {}h out of range ({}-{}h)", hours, MIN_DURATION_HOURS, MAX_DURATION_HOURS)));
        }
    if let Some(ref encoder) = overrides.encoder
        && !VALID_ENCODERS.contains(&encoder.as_str()) {
            return Err(AppError::Pipeline(format!("Invalid encoder: {}. Valid: {:?}", encoder, VALID_ENCODERS)));
        }
    if let Some(ref prefix) = overrides.output_prefix {
        if prefix.len() > MAX_PREFIX_LEN {
            return Err(AppError::Pipeline(format!("Output prefix too long: {} > {}", prefix.len(), MAX_PREFIX_LEN)));
        }
        if prefix.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
            return Err(AppError::Pipeline("Output prefix contains invalid characters".into()));
        }
    }
    if let Some(ref maxrate) = overrides.maxrate {
        validate_bitrate(maxrate)?;
    }
    if let Some(jobs) = overrides.max_concurrent_jobs
        && (!(MIN_CONCURRENT_JOBS..=MAX_CONCURRENT_JOBS).contains(&jobs)) {
            return Err(AppError::Pipeline(format!("Max concurrent jobs {} out of range ({}-{})", jobs, MIN_CONCURRENT_JOBS, MAX_CONCURRENT_JOBS)));
        }
    if let Some(ref watermark) = overrides.watermark_path {
        let _ = sanitize_path(watermark)?;
        if !watermark.to_lowercase().ends_with(".png") {
            return Err(AppError::Pipeline("Watermark must be a PNG file".into()));
        }
    }
    if let Some(opacity) = overrides.watermark_opacity
        && (!(MIN_WATERMARK_OPACITY..=MAX_WATERMARK_OPACITY).contains(&opacity)) {
            return Err(AppError::Pipeline(format!("Watermark opacity {} out of range ({}-{})", opacity, MIN_WATERMARK_OPACITY, MAX_WATERMARK_OPACITY)));
        }
    Ok(())
}