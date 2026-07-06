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
const MAX_LOOP_COUNT: usize = 100;
const MIN_LOOP_COUNT: usize = 1;
const MAX_WATERMARK_OPACITY: f32 = 1.0;
const MIN_WATERMARK_OPACITY: f32 = 0.0;
const VALID_ENCODERS: &[&str] = &[
    "libx264", "h264_nvenc", "h264_amf", "h264_qsv",
    "libx265", "hevc_nvenc", "hevc_amf", "hevc_qsv",
    "av1_nvenc", "av1_amf", "av1_qsv", "libsvtav1",
];
const MAX_PREFIX_LEN: usize = 100;
const MAX_PATH_LEN: usize = 4096;

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "NUL", "PRN", "AUX",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Unicode characters that can be used to bypass `..` detection
const TRAVERSAL_UNICODE_VARIANTS: &[char] = &[
    '\u{2025}', // ‥  double vertical line (looks like ..)
    '\u{2026}', // …  horizontal ellipsis
    '\u{2044}', // ⁄  fraction slash (like /)
    '\u{2215}', // ∕  division slash (like /)
    '\u{FF0F}', // ／ fullwidth solidus (like /)
    '\u{FF0E}', // ． fullwidth full stop (like .)
    '\u{2E2F}', // ⸯ vertical tilde
    '\u{2E3C}', // ⸼ stenographic full stop
    '\u{2E3D}', // ⸽ vertical six dots
];

fn has_traversal_unicode(path: &str) -> bool {
    path.chars().any(|c| TRAVERSAL_UNICODE_VARIANTS.contains(&c))
}

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
    if has_traversal_unicode(path) {
        return Err(AppError::Pipeline("Path contains Unicode traversal characters".into()));
    }
    let path = Path::new(path);
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::Pipeline("Path traversal detected".into()));
    }
    if cfg!(windows) && path.to_string_lossy().starts_with("\\\\") {
        return Err(AppError::Pipeline("UNC paths are not allowed".into()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('-') {
            return Err(AppError::Pipeline("Filename starts with '-' which may be misinterpreted as a flag".into()));
        }
        if cfg!(windows) {
            let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_ascii_uppercase();
            if WINDOWS_RESERVED.contains(&stem.as_str()) {
                return Err(AppError::Pipeline(format!("Windows reserved filename: {}", name)));
            }
        }
    }
    Ok(path.to_path_buf())
}

pub fn resolve_and_validate_path(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, AppError> {
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = path.parent().unwrap_or(path);
            let canonical_parent = parent.canonicalize().map_err(|e| {
                AppError::Pipeline(format!("Failed to resolve path: {}", e))
            })?;
            canonical_parent.join(path.file_name().unwrap_or(path.as_os_str()))
        }
    };
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
        }
        MediaSource::Files { paths } => {
            if paths.is_empty() {
                return Err(AppError::Pipeline(format!("{} files list is empty", media_type)));
            }
            for p in paths {
                let _ = sanitize_path(p)?;
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
    if let Some(count) = overrides.loop_count
        && (!(MIN_LOOP_COUNT..=MAX_LOOP_COUNT).contains(&count)) {
            return Err(AppError::Pipeline(format!("Loop count {} out of range ({}-{})", count, MIN_LOOP_COUNT, MAX_LOOP_COUNT)));
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
        if !std::path::Path::new(watermark).exists() {
            return Err(AppError::Pipeline(format!("Watermark file not found: {}", watermark)));
        }
    }
    if let Some(opacity) = overrides.watermark_opacity
        && (!(MIN_WATERMARK_OPACITY..=MAX_WATERMARK_OPACITY).contains(&opacity)) {
            return Err(AppError::Pipeline(format!("Watermark opacity {} out of range ({}-{})", opacity, MIN_WATERMARK_OPACITY, MAX_WATERMARK_OPACITY)));
        }
    Ok(())
}