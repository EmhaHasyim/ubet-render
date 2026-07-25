use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::{MediaSource, OverrideConfig};
use std::path::{Path, PathBuf};

const MAX_BITRATE_K: u32 = 50000;
const MIN_BITRATE_K: u32 = 100;
const MAX_SONGS_PER_PLAYLIST: usize = 100;
const MIN_SONGS_PER_PLAYLIST: usize = 1;
const MAX_DURATION_HOURS: f64 = 24.0;
const MIN_DURATION_HOURS: f64 = 0.1;
const MAX_LOOP_COUNT: usize = 100;
const MIN_LOOP_COUNT: usize = 1;
pub(crate) const VALID_ENCODERS: &[&str] = &[
    "libx264", "h264_nvenc", "h264_amf", "h264_qsv",
    "libx265", "hevc_nvenc", "hevc_amf", "hevc_qsv",
    // AV1: include bare codec name + every common AOM / SVT / vendor
    // hardware alias so any of them can be persisted in the config file.
    // The pipeline's `map_encoder_to_codec` normalizes everything to
    // canonical "av1", so the smart skip-reencode heuristic recognizes a
    // source AV1 stream regardless of which exact encoder produced it.
    "av1", "libaom-av1", "aom", "svt-av1",
    "av1_nvenc", "av1_amf", "av1_qsv", "av1_mf",
    "av1_vaapi", "av1_v4l2m2m", "libsvtav1",
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

pub(crate) fn sanitize_path(path: &str) -> Result<PathBuf, AppError> {
    if path.len() > MAX_PATH_LEN {
        return Err(AppError::Pipeline(format!("Path too long: {} > {}", path.len(), MAX_PATH_LEN)));
    }
    if path.contains('\0') {
        return Err(AppError::Pipeline("Path contains null byte".into()));
    }
    // Reject NTFS Alternate Data Streams (e.g. `video.mp4:$DATA`).  The colon
    // after the drive letter on Windows is position 1, so any colon at
    // position > 1 is suspicious.
    if let Some(col_pos) = path.find(':')
        && col_pos > 1
    {
        return Err(AppError::Pipeline("Path contains NTFS alternate data stream marker".into()));
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
    // Windows resolves three-or-more-dot components (..., ...., etc.) as
    // parent-directory traversal equivalent to `..` in some APIs, so they
    // must be rejected alongside the standard `ParentDir` check above.
    if path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.len() >= 3 && s.bytes().all(|b| b == b'.'))
    }) {
        return Err(AppError::Pipeline("Path traversal detected (multi-dot component)".into()));
    }
    if cfg!(windows) && path.to_string_lossy().starts_with("\\\\") {
        return Err(AppError::Pipeline("UNC paths are not allowed".into()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('-') {
            return Err(AppError::Pipeline("Filename starts with '-' which may be misinterpreted as a flag".into()));
        }
        if cfg!(windows) && {
            let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_ascii_uppercase();
            WINDOWS_RESERVED.contains(&stem.as_str())
        } {
            return Err(AppError::Pipeline(format!("Windows reserved filename: {}", name)));
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
            let p = Path::new(path);
            if !p.is_dir() {
                return Err(AppError::Pipeline(format!(
                    "{} folder does not exist or is not a directory: {}",
                    media_type, path
                )));
            }
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

pub(crate) fn is_valid_encoder(encoder: &str) -> bool {
    VALID_ENCODERS.contains(&encoder)
}

pub(crate) fn validate_bitrate(bitrate: &str) -> Result<u32, AppError> {
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
    if let Some(ref mode) = overrides.audio_mode
        && !matches!(mode.as_str(), "original" | "normalize") {
            return Err(AppError::Pipeline(format!(
                "Invalid audioMode: '{}'. Valid: 'original' or 'normalize'",
                mode
            )));
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
    if let Some(ref fmt) = overrides.output_format
        && !matches!(fmt.as_str(), "mp4" | "mkv") {
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
    validate_directory_path(&config.directories.video, "video")?;
    validate_directory_path(&config.directories.audio, "audio")?;
    validate_directory_path(&config.directories.output, "output")?;
    if is_system_protected_path(Path::new(&config.directories.output)) {
        return Err(AppError::Pipeline(format!(
            "Output directory resolves inside a system-protected location and cannot be used: {}",
            config.directories.output
        )));
    }
    validate_directory_path(&config.directories.cache, "cache")?;

    validate_bitrate(&config.video.bitrate_target)?;
    validate_bitrate(&config.video.bitrate_max)?;

    if !is_valid_encoder(&config.video.encoder) {
        return Err(AppError::Pipeline(format!(
            "Invalid encoder: '{}'. Valid: {:?}",
            config.video.encoder, VALID_ENCODERS
        )));
    }

    if !(MIN_SONGS_PER_PLAYLIST..=MAX_SONGS_PER_PLAYLIST).contains(&config.audio.songs_per_playlist) {
        return Err(AppError::Pipeline(format!(
            "songs_per_playlist {} out of range ({}-{})",
            config.audio.songs_per_playlist, MIN_SONGS_PER_PLAYLIST, MAX_SONGS_PER_PLAYLIST
        )));
    }

    if config.audio.sample_rate == 0 {
        return Err(AppError::Pipeline("sample_rate must be greater than 0".into()));
    }

    validate_loudnorm_params(&config.audio.loudnorm_params)?;

    if config.target.min_duration_sec == 0 {
        return Err(AppError::Pipeline("min_duration_sec must be greater than 0".into()));
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
        let first = chars.next().expect("value_part must be non-empty (checked above)");
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
        return Err(AppError::Pipeline(format!("{} directory path is empty", name)));
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
        "/bin", "/sbin", "/usr", "/etc", "/boot", "/System", "/lib", "/lib64", "/proc",
        "/sys",
    ] {
        if let Some(sys) = canonicalize_lenient(Path::new(d)) {
            if canonical.starts_with(&sys) {
                return true;
            }
        }
    }
    false
}

/// Like [`std::path::Path::canonicalize`] but tolerant of not-yet-existing
/// paths: canonicalizes the (existing) parent and re-appends the final
/// component. Lets system-location checks work for output dirs that haven't
/// been created yet.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    if let Ok(c) = path.canonicalize() {
        return Some(c);
    }
    let parent = path.parent()?;
    let name = path.file_name()?;
    let canon_parent = parent.canonicalize().ok()?;
    Some(canon_parent.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_sanitize_path_unicode_traversal_dots() {
        // U+2025 ‥ double vertical line (looks like ..)
        let result = sanitize_path("video\u{2025}mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Unicode traversal"));
    }

    #[test]
    fn test_sanitize_path_unicode_traversal_slash() {
        // U+FF0F ／ fullwidth solidus (looks like /)
        let result = sanitize_path("video\u{FF0F}mp4");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Unicode traversal"));
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
        assert!(result.unwrap_err().to_string().contains("Invalid bitrate format"));
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
        assert!(resolve_and_validate_path(&canon, &allowed)
            .unwrap_err()
            .to_string()
            .contains("outside allowed"));
    }

    // -----------------------------------------------------------------------
    // has_traversal_unicode
    // -----------------------------------------------------------------------

    #[test]
    fn test_has_traversal_unicode_all_variants() {
        for &ch in TRAVERSAL_UNICODE_VARIANTS {
            let s: String = ch.to_string();
            assert!(has_traversal_unicode(&s), "char U+{:04X} should be detected", ch as u32);
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
            assert!(validate_override_config(&config).is_ok(), "encoder '{}' should be valid", enc);
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
            assert!(validate_override_config(&config).is_ok(), "mode '{}' should be valid", mode);
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
            assert!(validate_override_config(&config).is_ok(), "format '{}' should be valid", fmt);
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
            assert!(validate_override_config(&config).is_err(), "char '{}' should be rejected", ch);
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
}