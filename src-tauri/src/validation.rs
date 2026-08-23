use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::job::RenderJob;
use crate::models::settings::{MediaSource, OverrideConfig};
use std::path::{Path, PathBuf};

const MAX_BITRATE_K: u32 = 50000;
const MIN_BITRATE_K: u32 = 100;
const MAX_SONGS_PER_PLAYLIST: usize = 100;
const MIN_SONGS_PER_PLAYLIST: usize = 1;
const MAX_DURATION_HOURS: f64 = 24.0;
const MIN_DURATION_HOURS: f64 = 0.1;
const MAX_TARGET_DURATION_SEC: u64 = (MAX_DURATION_HOURS as u64) * 3600;
const MAX_LOOP_COUNT: usize = 100;
const MIN_LOOP_COUNT: usize = 1;
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 192_000;
const MAX_CONCURRENT_PREP: usize = 64;
const MAX_PADDING_SEC: u64 = 86_400;
pub(crate) const MAX_SOURCE_FILES: usize = 10_000;
pub(crate) const MAX_RESUME_STATE_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const MAX_RESUMED_TIMESTAMPS: usize = 100_000;
pub(crate) const VALID_ENCODERS: &[&str] = &[
    "libx264",
    "h264_nvenc",
    "h264_amf",
    "h264_qsv",
    "libx265",
    "hevc_nvenc",
    "hevc_amf",
    "hevc_qsv",
    // AV1: include bare codec name + every common AOM / SVT / vendor
    // hardware alias so any of them can be persisted in the config file.
    // The pipeline's `map_encoder_to_codec` normalizes everything to
    // canonical "av1", so the smart skip-reencode heuristic recognizes a
    // source AV1 stream regardless of which exact encoder produced it.
    "av1",
    "libaom-av1",
    "aom",
    "svt-av1",
    "av1_nvenc",
    "av1_amf",
    "av1_qsv",
    "av1_mf",
    "av1_vaapi",
    "av1_v4l2m2m",
    "libsvtav1",
];
const MAX_PREFIX_LEN: usize = 100;
const MAX_PATH_LEN: usize = 4096;
/// Maximum parent-directory walk depth for [`canonicalize_lenient`].
/// A depth above this value is treated as a malformed or adversarial path
/// and causes the function to return `None` rather than loop indefinitely.
const MAX_CANONICALIZE_DEPTH: usize = 256;

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "NUL", "PRN", "AUX", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
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
    path.chars()
        .any(|c| TRAVERSAL_UNICODE_VARIANTS.contains(&c))
}

pub(crate) fn sanitize_path(path: &str) -> Result<PathBuf, AppError> {
    if path.len() > MAX_PATH_LEN {
        return Err(AppError::Pipeline(format!(
            "Path too long: {} > {}",
            path.len(),
            MAX_PATH_LEN
        )));
    }
    if path.contains('\0') {
        return Err(AppError::Pipeline("Path contains null byte".into()));
    }
    // Reject NTFS Alternate Data Streams on Windows (e.g. `video.mp4:$DATA`).
    // `:` is the drive-letter separator at byte position 1 on Windows; any
    // colon elsewhere (relative path, or a second colon after the drive
    // prefix) is an ADS marker and must be rejected.
    //
    // macOS and Linux, however, treat `:` as a perfectly legal filename
    // character (e.g. `My:Song.mp3`), so this check MUST NOT apply there —
    // doing so would make legitimate files unrenderable.
    #[cfg(windows)]
    if let Some(col_pos) = path.find(':') {
        let is_drive_colon = col_pos == 1;
        let has_second_colon = path[col_pos + 1..].contains(':');
        if !is_drive_colon || has_second_colon {
            return Err(AppError::Pipeline(
                "Path contains NTFS alternate data stream marker".into(),
            ));
        }
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(AppError::Pipeline(
            "Path contains control characters".into(),
        ));
    }
    if has_traversal_unicode(path) {
        return Err(AppError::Pipeline(
            "Path contains Unicode traversal characters".into(),
        ));
    }
    let path = Path::new(path);
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Pipeline("Path traversal detected".into()));
    }
    // Windows resolves three-or-more-dot components (..., ...., etc.) as
    // parent-directory traversal equivalent to `..` in some APIs, so they
    // must be rejected alongside the standard `ParentDir` check above.
    if path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.len() >= 3 && s.bytes().all(|b| b == b'.'))
    }) {
        return Err(AppError::Pipeline(
            "Path traversal detected (multi-dot component)".into(),
        ));
    }
    if cfg!(windows) && path.to_string_lossy().starts_with("\\\\") {
        return Err(AppError::Pipeline("UNC paths are not allowed".into()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('-') {
            return Err(AppError::Pipeline(
                "Filename starts with '-' which may be misinterpreted as a flag".into(),
            ));
        }
        if cfg!(windows) && {
            let stem = Path::new(name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(name)
                .to_ascii_uppercase();
            WINDOWS_RESERVED.contains(&stem.as_str())
        } {
            return Err(AppError::Pipeline(format!(
                "Windows reserved filename: {}",
                name
            )));
        }
    }
    Ok(path.to_path_buf())
}

pub fn resolve_and_validate_path(
    path: &Path,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, AppError> {
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = path.parent().unwrap_or(path);
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Pipeline(format!("Failed to resolve path: {}", e)))?;
            canonical_parent.join(path.file_name().unwrap_or(path.as_os_str()))
        }
    };
    let is_allowed = allowed_roots.iter().any(|root| {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        canonical.starts_with(canonical_root)
    });
    if !is_allowed {
        return Err(AppError::Pipeline(
            "Path resolves outside allowed directories".into(),
        ));
    }
    Ok(canonical)
}

fn validate_media_source(source: &MediaSource, media_type: &str) -> Result<(), AppError> {
    match source {
        MediaSource::Folder { path } => {
            let _ = sanitize_path(path)?;
            let p = Path::new(path);
            if !p.is_dir() {
                return Err(AppError::Pipeline(format!(
                    "{} folder does not exist or is not a directory: {}",
                    media_type, path
                )));
            }
        }
        MediaSource::Files { paths } => {
            if paths.len() > MAX_SOURCE_FILES {
                return Err(AppError::Pipeline(format!(
                    "{} source contains too many paths: {} > {}",
                    media_type,
                    paths.len(),
                    MAX_SOURCE_FILES
                )));
            }
            if paths.is_empty() {
                return Err(AppError::Pipeline(format!(
                    "{} files list is empty",
                    media_type
                )));
            }
            for p in paths {
                let _ = sanitize_path(p)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn is_valid_encoder(encoder: &str) -> bool {
    VALID_ENCODERS.contains(&encoder)
}

pub(crate) fn validate_bitrate(bitrate: &str) -> Result<u32, AppError> {
    let normalized = bitrate.trim().to_ascii_lowercase();
    let number = normalized.strip_suffix('k').unwrap_or(&normalized);
    let k = number
        .parse::<u32>()
        .map_err(|_| AppError::Pipeline(format!("Invalid bitrate format: {}", bitrate)))?;
    if !(MIN_BITRATE_K..=MAX_BITRATE_K).contains(&k) {
        return Err(AppError::Pipeline(format!(
            "Bitrate {}k out of range ({}-{}k)",
            k, MIN_BITRATE_K, MAX_BITRATE_K
        )));
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
        && (!(MIN_SONGS_PER_PLAYLIST..=MAX_SONGS_PER_PLAYLIST).contains(&songs))
    {
        return Err(AppError::Pipeline(format!(
            "Songs per playlist {} out of range ({}-{})",
            songs, MIN_SONGS_PER_PLAYLIST, MAX_SONGS_PER_PLAYLIST
        )));
    }
    if let Some(hours) = overrides.min_duration_hours
        && (!(MIN_DURATION_HOURS..=MAX_DURATION_HOURS).contains(&hours))
    {
        return Err(AppError::Pipeline(format!(
            "Min duration {}h out of range ({}-{}h)",
            hours, MIN_DURATION_HOURS, MAX_DURATION_HOURS
        )));
    }
    if let Some(count) = overrides.loop_count
        && (!(MIN_LOOP_COUNT..=MAX_LOOP_COUNT).contains(&count))
    {
        return Err(AppError::Pipeline(format!(
            "Loop count {} out of range ({}-{})",
            count, MIN_LOOP_COUNT, MAX_LOOP_COUNT
        )));
    }
    if let Some(ref encoder) = overrides.encoder
        && !VALID_ENCODERS.contains(&encoder.as_str())
    {
        return Err(AppError::Pipeline(format!(
            "Invalid encoder: {}. Valid: {:?}",
            encoder, VALID_ENCODERS
        )));
    }
    if let Some(ref mode) = overrides.audio_mode
        && !matches!(mode.as_str(), "original" | "normalize")
    {
        return Err(AppError::Pipeline(format!(
            "Invalid audioMode: '{}'. Valid: 'original' or 'normalize'",
            mode
        )));
    }
    if let Some(ref prefix) = overrides.output_prefix {
        validate_output_prefix(prefix)?;
    }
    if let Some(ref maxrate) = overrides.maxrate {
        validate_bitrate(maxrate)?;
    }
    if let Some(ref fmt) = overrides.output_format
        && !matches!(fmt.as_str(), "mp4" | "mkv")
    {
        return Err(AppError::Pipeline(format!(
            "Invalid outputFormat: '{}'. Valid: 'mp4' or 'mkv'",
            fmt
        )));
    }
    // (concurrent-jobs feature removed)
    // (watermark feature removed)
    Ok(())
}

/// Validates a complete application configuration before it is persisted or
/// used by the render pipeline. All paths are sanitized, bitrates/encoder are
/// checked, and audio parameters are restricted to safe values.
pub fn validate_app_config(config: &AppConfig) -> Result<(), AppError> {
    for (name, path) in [
        ("video", &config.directories.video),
        ("audio", &config.directories.audio),
        ("output", &config.directories.output),
        ("cache", &config.directories.cache),
    ] {
        validate_directory_path(path, name)?;
        if is_system_protected_path(Path::new(path)) {
            return Err(AppError::Pipeline(format!(
                "{} directory resolves inside a system-protected location and cannot be used: {}",
                name, path
            )));
        }
    }
    validate_output_prefix(&config.metadata.channel_prefix)?;

    let target_bitrate = validate_bitrate(&config.video.bitrate_target)?;
    let max_bitrate = validate_bitrate(&config.video.bitrate_max)?;
    if target_bitrate > max_bitrate {
        return Err(AppError::Pipeline(format!(
            "Target bitrate {}k cannot exceed maximum bitrate {}k",
            target_bitrate, max_bitrate
        )));
    }

    if !is_valid_encoder(&config.video.encoder) {
        return Err(AppError::Pipeline(format!(
            "Invalid encoder: '{}'. Valid: {:?}",
            config.video.encoder, VALID_ENCODERS
        )));
    }

    if !(MIN_SONGS_PER_PLAYLIST..=MAX_SONGS_PER_PLAYLIST).contains(&config.audio.songs_per_playlist)
    {
        return Err(AppError::Pipeline(format!(
            "songs_per_playlist {} out of range ({}-{})",
            config.audio.songs_per_playlist, MIN_SONGS_PER_PLAYLIST, MAX_SONGS_PER_PLAYLIST
        )));
    }

    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&config.audio.sample_rate) {
        return Err(AppError::Pipeline(format!(
            "sample_rate {} out of range ({}-{} Hz)",
            config.audio.sample_rate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE
        )));
    }

    if !(1..=MAX_CONCURRENT_PREP).contains(&config.audio.concurrent_prep) {
        return Err(AppError::Pipeline(format!(
            "concurrent_prep {} out of range (1-{})",
            config.audio.concurrent_prep, MAX_CONCURRENT_PREP
        )));
    }

    validate_bitrate(&config.audio.bitrate)?;

    if !matches!(config.audio.audio_mode.as_str(), "original" | "normalize") {
        return Err(AppError::Pipeline(format!(
            "Invalid audio_mode: '{}'. Valid: 'original' or 'normalize'",
            config.audio.audio_mode
        )));
    }

    validate_loudnorm_params(&config.audio.loudnorm_params)?;

    if !(1..=MAX_TARGET_DURATION_SEC).contains(&config.target.min_duration_sec) {
        return Err(AppError::Pipeline(format!(
            "min_duration_sec {} out of range (1-{} seconds)",
            config.target.min_duration_sec, MAX_TARGET_DURATION_SEC
        )));
    }
    if config.target.padding_sec > MAX_PADDING_SEC {
        return Err(AppError::Pipeline(format!(
            "padding_sec {} exceeds maximum {} seconds",
            config.target.padding_sec, MAX_PADDING_SEC
        )));
    }

    Ok(())
}

/// Validates loudnorm parameter string. Only accepts the format
/// I=<dB>:LRA=<dB>:TP=<dB> where each value is a signed/unsigned decimal number.
/// This prevents arbitrary FFmpeg filter injection through the loudnorm string.
pub fn validate_loudnorm_params(params: &str) -> Result<(), AppError> {
    if params.is_empty() {
        return Err(AppError::Pipeline("loudnorm_params cannot be empty".into()));
    }

    let parts: Vec<&str> = params.split(':').collect();
    if parts.len() != 3 {
        return Err(AppError::Pipeline(format!(
            "Invalid loudnorm_params format: '{}'. Expected I=<dB>:LRA=<dB>:TP=<dB>",
            params
        )));
    }

    let expected = [("I="), ("LRA="), ("TP=")];
    for (part, prefix) in parts.iter().zip(expected.iter()) {
        let value_part = part.strip_prefix(prefix).ok_or_else(|| {
            AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Expected prefix '{}' in part '{}'",
                params, prefix, part
            ))
        })?;

        if value_part.is_empty() {
            return Err(AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Value for '{}' is empty",
                params, prefix
            )));
        }

        let mut chars = value_part.chars();
        // SAFETY: we already checked `value_part.is_empty()` above, so
        //         `chars.next()` is guaranteed to return `Some`.
        let first = chars
            .next()
            .expect("value_part must be non-empty (checked above)");
        let rest: String = chars.collect();
        let numeric = if first == '-' || first == '+' {
            rest.as_str()
        } else {
            value_part
        };

        if numeric.is_empty() {
            return Err(AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Value for '{}' is not a number",
                params, prefix
            )));
        }

        let mut dot_seen = false;
        for c in numeric.chars() {
            if c == '.' {
                if dot_seen {
                    return Err(AppError::Pipeline(format!(
                        "Invalid loudnorm_params format: '{}'. Value for '{}' has multiple decimal points",
                        params, prefix
                    )));
                }
                dot_seen = true;
            } else if !c.is_ascii_digit() {
                return Err(AppError::Pipeline(format!(
                    "Invalid loudnorm_params format: '{}'. Value for '{}' contains invalid character '{}'",
                    params, prefix, c
                )));
            }
        }
    }

    Ok(())
}

fn validate_directory_path(path: &str, name: &str) -> Result<(), AppError> {
    let _ = sanitize_path(path)?;
    if path.trim().is_empty() {
        return Err(AppError::Pipeline(format!(
            "{} directory path is empty",
            name
        )));
    }
    Ok(())
}

pub(crate) fn validate_output_prefix(prefix: &str) -> Result<(), AppError> {
    if prefix.chars().count() > MAX_PREFIX_LEN {
        return Err(AppError::Pipeline(format!(
            "Output prefix too long: {} > {} characters",
            prefix.chars().count(),
            MAX_PREFIX_LEN
        )));
    }
    if prefix.chars().any(|c| {
        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err(AppError::Pipeline(
            "Output prefix contains invalid characters".into(),
        ));
    }
    Ok(())
}

/// Validate state loaded from disk before any persisted path is handed to
/// FFmpeg. State files are recoverable application data, not a trusted source.
pub(crate) fn validate_resumed_jobs(
    jobs: &[RenderJob],
    output_root: &Path,
    input_roots: &[PathBuf],
    thumbnail_root: &Path,
) -> Result<(), AppError> {
    const MAX_RESUMED_JOBS: usize = 10_000;
    if jobs.is_empty() {
        return Err(AppError::Pipeline("Resume state contains no jobs".into()));
    }
    if jobs.len() > MAX_RESUMED_JOBS {
        return Err(AppError::Pipeline(format!(
            "Resume state contains too many jobs: {} > {}",
            jobs.len(),
            MAX_RESUMED_JOBS
        )));
    }

    let total_timestamps: usize = jobs.iter().map(|job| job.timestamps.len()).sum();
    if total_timestamps > MAX_RESUMED_TIMESTAMPS {
        return Err(AppError::Pipeline(format!(
            "Resume state contains too many timestamps: {} > {}",
            total_timestamps, MAX_RESUMED_TIMESTAMPS
        )));
    }

    for (index, job) in jobs.iter().enumerate() {
        let input = sanitize_path(&job.video.input_path)?;
        let input = resolve_and_validate_path(&input, input_roots).map_err(|e| {
            AppError::Pipeline(format!("Resume job {} input path rejected: {}", index, e))
        })?;
        if !input.is_file() {
            return Err(AppError::Pipeline(format!(
                "Resume job {} input is not a file: {}",
                index,
                input.display()
            )));
        }

        let output = sanitize_path(&job.video.output_path)?;
        let output =
            resolve_and_validate_path(&output, &[output_root.to_path_buf()]).map_err(|e| {
                AppError::Pipeline(format!("Resume job {} output path rejected: {}", index, e))
            })?;
        if output.exists() && output.is_dir() {
            return Err(AppError::Pipeline(format!(
                "Resume job {} output is a directory: {}",
                index,
                output.display()
            )));
        }

        if job.video.name.is_empty()
            || job.video.name.chars().count() > MAX_PATH_LEN
            || job.video.name.chars().any(|c| c.is_control())
            || job.current_step.chars().count() > MAX_PATH_LEN
            || job.current_step.chars().any(|c| c.is_control())
            || job.error.as_deref().is_some_and(|error| {
                error.chars().count() > MAX_PATH_LEN || error.chars().any(|c| c.is_control())
            })
            || job.timestamps.iter().any(|timestamp| {
                timestamp.chars().count() > MAX_PATH_LEN
                    || timestamp.chars().any(|c| c.is_control())
            })
        {
            return Err(AppError::Pipeline(format!(
                "Resume job {} contains an invalid video name",
                index
            )));
        }

        if let Some(thumbnail) = &job.video.thumbnail_path {
            let thumbnail = sanitize_path(thumbnail)?;
            resolve_and_validate_path(&thumbnail, &[thumbnail_root.to_path_buf()]).map_err(
                |e| {
                    AppError::Pipeline(format!(
                        "Resume job {} thumbnail path rejected: {}",
                        index, e
                    ))
                },
            )?;
        }
    }
    Ok(())
}

/// Returns `true` if `path` resolves inside an OS/system-protected location
/// (e.g. the drive root, the Windows directory, or Unix core system dirs).
///
/// Defense-in-depth guard so the pipeline never writes rendered output into a
/// location that could damage the operating system. The directory need not
/// exist yet — the parent is canonicalized and the final component re-attached.
pub(crate) fn is_system_protected_path(path: &Path) -> bool {
    let Some(canonical) = canonicalize_lenient(path) else {
        return false;
    };

    // Bare drive/volume root, e.g. `C:\` (Windows) or `/` (Unix).
    let comps: Vec<_> = canonical.components().collect();
    #[cfg(windows)]
    {
        use std::path::Component;
        if comps.len() == 2
            && matches!(comps[0], Component::Prefix(_))
            && matches!(comps[1], Component::RootDir)
        {
            return true;
        }
    }
    #[cfg(not(windows))]
    {
        use std::path::Component;
        if comps.len() == 1 && matches!(comps[0], Component::RootDir) {
            return true;
        }
    }

    // Windows OS directory (SystemRoot / windir).
    #[cfg(windows)]
    for var in ["SystemRoot", "windir"] {
        if let Ok(val) = std::env::var(var)
            && let Some(sys) = canonicalize_lenient(Path::new(&val))
            && canonical.starts_with(&sys)
        {
            return true;
        }
    }
    // Unix core system directories.
    #[cfg(not(windows))]
    for d in [
        "/bin", "/sbin", "/usr", "/etc", "/boot", "/System", "/lib", "/lib64", "/proc", "/sys",
    ] {
        if let Some(sys) = canonicalize_lenient(Path::new(d)) {
            if canonical.starts_with(&sys) {
                return true;
            }
        }
    }
    false
}

/// Like [`std::path::Path::canonicalize`] but tolerant of paths whose final
/// components do not exist yet. Walks upward until it finds the nearest
/// existing ancestor, canonicalizes that ancestor, then appends the unresolved
/// suffix. This keeps protected-directory checks effective for nested paths
/// that would otherwise make only the immediate parent fail canonicalization.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    let mut unresolved = Vec::new();
    let mut depth: usize = 0;

    loop {
        depth += 1;
        if depth > MAX_CANONICALIZE_DEPTH {
            return None;
        }

        if let Ok(canonical_base) = current.canonicalize() {
            let mut result = canonical_base;
            for component in unresolved.iter().rev() {
                result.push(component);
            }
            return Some(result);
        }

        let name = current.file_name()?.to_os_string();
        unresolved.push(name);
        if !current.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::media::VideoFile;
    use crate::pipeline::estimator::{AUDIO_EXTENSIONS, VIDEO_EXTENSIONS};

    // -----------------------------------------------------------------------
    // sanitize_path
    // -----------------------------------------------------------------------

    #[test]
    fn test_sanitize_path_valid() {
        let result = sanitize_path("C:\\valid\\path\\video.mp4");
        assert!(result.is_ok());
    }

    #[test]
    fn test_sanitize_path_valid_relative() {
        let result = sanitize_path("videos/video.mp4");
        assert!(result.is_ok());
    }

    #[test]
    fn test_sanitize_path_too_long() {
        let long = "a".repeat(5000);
        let result = sanitize_path(&long);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Path too long"));
    }

    #[test]
    fn test_sanitize_path_null_byte() {
        let result = sanitize_path("valid\\video\0.mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("null byte"));
    }

    #[test]
    fn test_sanitize_path_control_char() {
        let result = sanitize_path("video\x01.mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("control"));
    }

    #[test]
    fn test_sanitize_path_parent_dir() {
        let result = sanitize_path("../video.mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("traversal"));
    }

    #[test]
    fn test_sanitize_path_nested_parent_dir() {
        let result = sanitize_path("a/b/../../../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("traversal"));
    }

    #[test]
    fn test_sanitize_path_flag_like() {
        let result = sanitize_path("C:\\videos\\-output.mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("flag"));
    }

    #[cfg(windows)]
    #[test]
    fn test_sanitize_path_rejects_ads_on_windows() {
        // NTFS Alternate Data Stream marker after the drive prefix.
        let result = sanitize_path("C:\\videos\\video.mp4:$DATA");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("alternate data stream")
        );

        // A bare drive path (no second colon) stays valid.
        assert!(sanitize_path("C:\\videos\\video.mp4").is_ok());
        assert!(sanitize_path("C:").is_ok());
    }

    #[cfg(not(windows))]
    #[test]
    fn test_sanitize_path_allows_colons_on_unix() {
        // `:` is a legal filename character on macOS/Linux — must NOT be
        // rejected as an NTFS ADS marker.
        let result = sanitize_path("music/My:Song.mp3");
        assert!(result.is_ok(), "colon in unix path should be allowed");
    }

    #[test]
    fn test_sanitize_path_unicode_traversal_dots() {
        // U+2025 ‥ double vertical line (looks like ..)
        let result = sanitize_path("video\u{2025}mp4");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Unicode traversal")
        );
    }

    #[test]
    fn test_sanitize_path_unicode_traversal_slash() {
        // U+FF0F ／ fullwidth solidus (looks like /)
        let result = sanitize_path("video\u{FF0F}mp4");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Unicode traversal")
        );
    }

    // -----------------------------------------------------------------------
    // validate_bitrate
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_bitrate_valid() {
        let result = validate_bitrate("4000k");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 4000);
    }

    #[test]
    fn test_validate_bitrate_valid_no_suffix() {
        let result = validate_bitrate("2000");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 2000);
    }

    #[test]
    fn test_validate_bitrate_too_low() {
        let result = validate_bitrate("50k");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("out of range"));
    }

    #[test]
    fn test_validate_bitrate_too_high() {
        let result = validate_bitrate("99999k");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("out of range"));
    }

    #[test]
    fn test_validate_bitrate_invalid_format() {
        let result = validate_bitrate("abc");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Invalid bitrate format")
        );
    }

    #[test]
    fn test_validate_bitrate_empty() {
        let result = validate_bitrate("");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_bitrate_trailing_whitespace() {
        let result = validate_bitrate("  4000k  ");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 4000);
    }

    #[test]
    fn test_validate_bitrate_case_insensitive() {
        let result = validate_bitrate("4000K");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 4000);
    }

    // -----------------------------------------------------------------------
    // resolve_and_validate_path
    // -----------------------------------------------------------------------

    #[test]
    fn test_resolve_and_validate_path_valid() {
        let cwd = std::env::current_dir().unwrap();
        let canon = std::fs::canonicalize(&cwd).unwrap_or_else(|_| cwd.clone());
        // A path is always inside itself
        let allowed = vec![canon.clone()];
        assert!(resolve_and_validate_path(&canon, &allowed).is_ok());
    }

    #[test]
    fn test_resolve_and_validate_path_rejected() {
        let cwd = std::env::current_dir().unwrap();
        let canon = std::fs::canonicalize(&cwd).unwrap_or_else(|_| cwd.clone());
        // Use a unique temp directory as the allowed root — cwd won't be inside it
        let temp_dir = std::env::temp_dir().join(format!("ubet_test_{}", std::process::id()));
        let allowed = vec![temp_dir];
        assert!(resolve_and_validate_path(&canon, &allowed).is_err());
        assert!(
            resolve_and_validate_path(&canon, &allowed)
                .unwrap_err()
                .to_string()
                .contains("outside allowed")
        );
    }

    // -----------------------------------------------------------------------
    // validate_resumed_jobs
    // -----------------------------------------------------------------------

    fn resume_test_job(input: &Path, output: &Path, thumbnail: Option<&Path>) -> RenderJob {
        RenderJob {
            video: VideoFile {
                name: input
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("input.mp4")
                    .to_string(),
                input_path: input.to_string_lossy().into_owned(),
                output_path: output.to_string_lossy().into_owned(),
                thumbnail_path: thumbnail.map(|path| path.to_string_lossy().into_owned()),
            },
            state: crate::models::job::JobState::Pending,
            progress_percent: 0,
            current_step: "Pending".into(),
            error: None,
            timestamps: Vec::new(),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn test_system_protected_path_rejects_nested_nonexistent_path() {
        let path = PathBuf::from(format!(
            "/usr/ubet-render-test-{}/nested/output",
            std::process::id()
        ));
        assert!(is_system_protected_path(&path));
    }

    #[cfg(windows)]
    #[test]
    fn test_system_protected_path_rejects_nested_nonexistent_path() {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let path = PathBuf::from(system_root)
            .join(format!("ubet-render-test-{}", std::process::id()))
            .join("nested")
            .join("output");
        assert!(is_system_protected_path(&path));
    }

    #[test]
    fn test_validate_resumed_jobs_accepts_paths_inside_roots() {
        let base =
            std::env::temp_dir().join(format!("ubet_resume_validation_{}", std::process::id()));
        let input_root = base.join("inputs");
        let output_root = base.join("outputs");
        let thumbnail_root = base.join("thumbnails");
        std::fs::create_dir_all(&input_root).unwrap();
        std::fs::create_dir_all(&output_root).unwrap();
        std::fs::create_dir_all(&thumbnail_root).unwrap();
        let input = input_root.join("clip.mp4");
        let thumbnail = thumbnail_root.join("clip.jpg");
        std::fs::write(&input, b"input").unwrap();
        std::fs::write(&thumbnail, b"thumbnail").unwrap();
        let job = resume_test_job(&input, &output_root.join("render.mp4"), Some(&thumbnail));
        let roots = vec![std::fs::canonicalize(&input_root).unwrap()];

        assert!(validate_resumed_jobs(&[job], &output_root, &roots, &thumbnail_root).is_ok());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn test_validate_resumed_jobs_rejects_tampered_output_root() {
        let base = std::env::temp_dir().join(format!("ubet_resume_tamper_{}", std::process::id()));
        let input_root = base.join("inputs");
        let output_root = base.join("outputs");
        let outside_root = base.join("outside");
        let thumbnail_root = base.join("thumbnails");
        std::fs::create_dir_all(&input_root).unwrap();
        std::fs::create_dir_all(&output_root).unwrap();
        std::fs::create_dir_all(&outside_root).unwrap();
        std::fs::create_dir_all(&thumbnail_root).unwrap();
        let input = input_root.join("clip.mp4");
        std::fs::write(&input, b"input").unwrap();
        let job = resume_test_job(&input, &outside_root.join("escape.mp4"), None);
        let roots = vec![std::fs::canonicalize(&input_root).unwrap()];

        let result = validate_resumed_jobs(&[job], &output_root, &roots, &thumbnail_root);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("output path rejected")
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn test_validate_resumed_jobs_rejects_too_many_timestamps() {
        let mut job = resume_test_job(Path::new("input.mp4"), Path::new("output.mp4"), None);
        job.timestamps = vec!["00:00 - clip".into(); MAX_RESUMED_TIMESTAMPS + 1];
        let result = validate_resumed_jobs(
            &[job],
            Path::new("/tmp/output"),
            &[PathBuf::from("/tmp/input")],
            Path::new("/tmp/thumbnails"),
        );
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("too many timestamps")
        );
    }

    #[test]
    fn test_validate_resumed_jobs_rejects_empty_state() {
        let result = validate_resumed_jobs(
            &[],
            Path::new("/tmp/output"),
            &[PathBuf::from("/tmp/input")],
            Path::new("/tmp/thumbnails"),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("no jobs"));
    }

    // -----------------------------------------------------------------------
    // has_traversal_unicode
    // -----------------------------------------------------------------------

    #[test]
    fn test_has_traversal_unicode_all_variants() {
        for &ch in TRAVERSAL_UNICODE_VARIANTS {
            let s: String = ch.to_string();
            assert!(
                has_traversal_unicode(&s),
                "char U+{:04X} should be detected",
                ch as u32
            );
        }
    }

    #[test]
    fn test_has_traversal_unicode_clean() {
        assert!(!has_traversal_unicode("normal_path.mp4"));
        assert!(!has_traversal_unicode("video/with/slashes.mp4"));
        assert!(!has_traversal_unicode(""));
    }

    // -----------------------------------------------------------------------
    // validate_override_config (happy path)
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_override_config_no_overrides() {
        let config = OverrideConfig {
            video_source: None,
            audio_source: None,
            output_path: None,
            songs_per_playlist: None,
            min_duration_hours: None,
            loop_count: None,
            encoder: None,
            output_prefix: None,
            maxrate: None,
            use_pingpong: None,
            audio_mode: None,
            embed_chapters: None,
            output_format: None,
            skip_intermediate_on_codec_match: None,
        };
        assert!(validate_override_config(&config).is_ok());
    }

    #[test]
    fn test_validate_override_config_rejects_too_many_paths() {
        let config = OverrideConfig {
            video_source: Some(MediaSource::Files {
                paths: vec!["clip.mp4".into(); MAX_SOURCE_FILES + 1],
            }),
            ..invalid_override()
        };
        let result = validate_override_config(&config);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too many paths"));
    }

    #[test]
    fn test_validate_override_config_songs_out_of_range() {
        let config = OverrideConfig {
            songs_per_playlist: Some(999),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_duration_out_of_range() {
        let config = OverrideConfig {
            min_duration_hours: Some(99.0),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_loop_count_out_of_range() {
        let config = OverrideConfig {
            loop_count: Some(999),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_invalid_encoder() {
        let config = OverrideConfig {
            encoder: Some("invalid_encoder".into()),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_valid_encoder() {
        for &enc in VALID_ENCODERS {
            let config = OverrideConfig {
                encoder: Some(enc.into()),
                ..invalid_override()
            };
            assert!(
                validate_override_config(&config).is_ok(),
                "encoder '{}' should be valid",
                enc
            );
        }
    }

    #[test]
    fn test_validate_override_config_invalid_audio_mode() {
        let config = OverrideConfig {
            audio_mode: Some("stereo".into()),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_valid_audio_modes() {
        for mode in &["original", "normalize"] {
            let config = OverrideConfig {
                audio_mode: Some(mode.to_string()),
                ..invalid_override()
            };
            assert!(
                validate_override_config(&config).is_ok(),
                "mode '{}' should be valid",
                mode
            );
        }
    }

    #[test]
    fn test_validate_override_config_invalid_output_format() {
        let config = OverrideConfig {
            output_format: Some("avi".into()),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_valid_output_formats() {
        for fmt in &["mp4", "mkv"] {
            let config = OverrideConfig {
                output_format: Some(fmt.to_string()),
                ..invalid_override()
            };
            assert!(
                validate_override_config(&config).is_ok(),
                "format '{}' should be valid",
                fmt
            );
        }
    }

    #[test]
    fn test_validate_override_config_prefix_too_long() {
        let config = OverrideConfig {
            output_prefix: Some("a".repeat(MAX_PREFIX_LEN + 1)),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    #[test]
    fn test_validate_override_config_prefix_invalid_chars() {
        for ch in &['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            let config = OverrideConfig {
                output_prefix: Some(format!("prefix{}", ch)),
                ..invalid_override()
            };
            assert!(
                validate_override_config(&config).is_err(),
                "char '{}' should be rejected",
                ch
            );
        }
    }

    #[test]
    fn test_validate_override_config_bitrate_valid() {
        let config = OverrideConfig {
            maxrate: Some("4000k".into()),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_ok());
    }

    #[test]
    fn test_validate_override_config_bitrate_invalid() {
        let config = OverrideConfig {
            maxrate: Some("abc".into()),
            ..invalid_override()
        };
        assert!(validate_override_config(&config).is_err());
    }

    // -----------------------------------------------------------------------
    // validate_loudnorm_params
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_loudnorm_params_valid() {
        assert!(validate_loudnorm_params("I=-14:LRA=11:TP=-1").is_ok());
        assert!(validate_loudnorm_params("I=-14.0:LRA=11.0:TP=-1.0").is_ok());
        assert!(validate_loudnorm_params("I=0:LRA=0:TP=0").is_ok());
    }

    #[test]
    fn test_validate_loudnorm_params_empty() {
        assert!(validate_loudnorm_params("").is_err());
    }

    #[test]
    fn test_validate_loudnorm_params_wrong_prefix() {
        assert!(validate_loudnorm_params("X=-14:LRA=11:TP=-1").is_err());
    }

    #[test]
    fn test_validate_loudnorm_params_too_many_parts() {
        assert!(validate_loudnorm_params("I=-14:LRA=11:TP=-1:EXTRA=1").is_err());
    }

    #[test]
    fn test_validate_loudnorm_params_invalid_characters() {
        assert!(validate_loudnorm_params("I=-14;LRA=11;TP=-1").is_err());
        assert!(validate_loudnorm_params("I=-14:LRA=11:TP=-1; rm -rf /").is_err());
    }

    #[test]
    fn test_validate_loudnorm_params_multiple_decimals() {
        assert!(validate_loudnorm_params("I=-14..0:LRA=11:TP=-1").is_err());
    }

    // -----------------------------------------------------------------------
    // validate_app_config
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_app_config_valid() {
        let config = crate::config::AppConfig::default();
        assert!(validate_app_config(&config).is_ok());
    }

    #[test]
    fn test_validate_app_config_invalid_bitrate() {
        let mut config = crate::config::AppConfig::default();
        config.video.bitrate_target = "abc".into();
        assert!(validate_app_config(&config).is_err());
    }

    #[test]
    fn test_validate_app_config_invalid_encoder() {
        let mut config = crate::config::AppConfig::default();
        config.video.encoder = "invalid".into();
        assert!(validate_app_config(&config).is_err());
    }

    #[test]
    fn test_validate_app_config_invalid_loudnorm() {
        let mut config = crate::config::AppConfig::default();
        config.audio.loudnorm_params = "invalid".into();
        assert!(validate_app_config(&config).is_err());
    }

    #[test]
    fn test_validate_app_config_zero_sample_rate() {
        let mut config = crate::config::AppConfig::default();
        config.audio.sample_rate = 0;
        assert!(validate_app_config(&config).is_err());
    }

    #[test]
    fn test_validate_app_config_target_bitrate_cannot_exceed_maximum() {
        let mut config = crate::config::AppConfig::default();
        config.video.bitrate_target = "6000k".into();
        config.video.bitrate_max = "5000k".into();
        assert!(validate_app_config(&config).is_err());
    }

    #[test]
    fn test_validate_app_config_rejects_invalid_audio_settings() {
        let mut config = crate::config::AppConfig::default();
        config.audio.audio_mode = "invalid".into();
        assert!(validate_app_config(&config).is_err());

        config.audio.audio_mode = "original".into();
        config.audio.bitrate = "not-a-bitrate".into();
        assert!(validate_app_config(&config).is_err());
    }

    /// Helper: returns an OverrideConfig with all fields set to None (valid
    /// per the validation logic since None = no override).
    fn invalid_override() -> OverrideConfig {
        OverrideConfig {
            video_source: None,
            audio_source: None,
            output_path: None,
            songs_per_playlist: None,
            min_duration_hours: None,
            loop_count: None,
            encoder: None,
            output_prefix: None,
            maxrate: None,
            use_pingpong: None,
            audio_mode: None,
            embed_chapters: None,
            output_format: None,
            skip_intermediate_on_codec_match: None,
        }
    }

    // -----------------------------------------------------------------------
    // Drift-detection sentinels — media format allow-list
    // -----------------------------------------------------------------------
    //
    // These EXPECTED_* lists are the **machine-enforced mirror** of the
    // canonical allow-list documented in `docs/MEDIA_EXTENSIONS.md`. They
    // mirror the TypeScript sentinels in `src/core/config.test.ts`.
    //
    // If a contributor changes VIDEO_EXTENSIONS / AUDIO_EXTENSIONS above
    // without also updating BOTH the TS and the Rust sentinels, one side's
    // drift test will fail in CI. Bump all three places together when adding
    // a new format to the canonical list.

    const EXPECTED_VIDEO_EXTENSIONS_RUST: &[&str] =
        &[".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".wmv"];
    const EXPECTED_AUDIO_EXTENSIONS_RUST: &[&str] = &[
        ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".opus", ".aiff", ".aif",
    ];

    #[test]
    fn test_video_extensions_match_canonical_list() {
        assert_eq!(VIDEO_EXTENSIONS, EXPECTED_VIDEO_EXTENSIONS_RUST);
    }

    #[test]
    fn test_audio_extensions_match_canonical_list() {
        assert_eq!(AUDIO_EXTENSIONS, EXPECTED_AUDIO_EXTENSIONS_RUST);
    }
}
