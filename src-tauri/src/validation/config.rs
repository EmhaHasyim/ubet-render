use super::limits::*;
use super::path::{is_system_protected_path, resolve_and_validate_path, sanitize_path};
use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::job::RenderJob;
use crate::models::settings::{MediaSource, OverrideConfig};
use std::path::{Path, PathBuf};

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

fn validate_media_source(source: &MediaSource, media_type: &str) -> Result<(), AppError> {
    match source {
        MediaSource::Folder { path } => {
            sanitize_path(path)?;
            if !Path::new(path).is_dir() {
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
            for path in paths {
                sanitize_path(path)?;
            }
        }
    }
    Ok(())
}

pub fn validate_override_config(overrides: &OverrideConfig) -> Result<(), AppError> {
    if let Some(source) = &overrides.video_source {
        validate_media_source(source, "Video")?;
    }
    if let Some(source) = &overrides.audio_source {
        validate_media_source(source, "Audio")?;
    }
    if let Some(path) = &overrides.output_path {
        sanitize_path(path)?;
    }
    if let Some(value) = overrides.songs_per_playlist
        && !(MIN_SONGS_PER_PLAYLIST..=MAX_SONGS_PER_PLAYLIST).contains(&value)
    {
        return Err(AppError::Pipeline(format!(
            "Songs per playlist {} out of range ({}-{})",
            value, MIN_SONGS_PER_PLAYLIST, MAX_SONGS_PER_PLAYLIST
        )));
    }
    if let Some(value) = overrides.min_duration_hours
        && !(MIN_DURATION_HOURS..=MAX_DURATION_HOURS).contains(&value)
    {
        return Err(AppError::Pipeline(format!(
            "Min duration {}h out of range ({}-{}h)",
            value, MIN_DURATION_HOURS, MAX_DURATION_HOURS
        )));
    }
    if let Some(value) = overrides.loop_count
        && !(MIN_LOOP_COUNT..=MAX_LOOP_COUNT).contains(&value)
    {
        return Err(AppError::Pipeline(format!(
            "Loop count {} out of range ({}-{})",
            value, MIN_LOOP_COUNT, MAX_LOOP_COUNT
        )));
    }
    if let Some(encoder) = &overrides.encoder
        && !is_valid_encoder(encoder)
    {
        return Err(AppError::Pipeline(format!(
            "Invalid encoder: {}. Valid: {:?}",
            encoder, VALID_ENCODERS
        )));
    }
    if let Some(mode) = &overrides.audio_mode
        && !matches!(mode.as_str(), "original" | "normalize")
    {
        return Err(AppError::Pipeline(format!(
            "Invalid audioMode: '{}'. Valid: 'original' or 'normalize'",
            mode
        )));
    }
    if let Some(prefix) = &overrides.output_prefix {
        validate_output_prefix(prefix)?;
    }
    if let Some(maxrate) = &overrides.maxrate {
        validate_bitrate(maxrate)?;
    }
    if let Some(format) = &overrides.output_format
        && !matches!(format.as_str(), "mp4" | "mkv")
    {
        return Err(AppError::Pipeline(format!(
            "Invalid outputFormat: '{}'. Valid: 'mp4' or 'mkv'",
            format
        )));
    }
    Ok(())
}

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
    let target = validate_bitrate(&config.video.bitrate_target)?;
    let maximum = validate_bitrate(&config.video.bitrate_max)?;
    if target > maximum {
        return Err(AppError::Pipeline(format!(
            "Target bitrate {}k cannot exceed maximum bitrate {}k",
            target, maximum
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
    for (part, prefix) in parts.iter().zip(["I=", "LRA=", "TP="].iter()) {
        let value = part.strip_prefix(prefix).ok_or_else(|| {
            AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Expected prefix '{}' in part '{}'",
                params, prefix, part
            ))
        })?;
        if value.is_empty() {
            return Err(AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Value for '{}' is empty",
                params, prefix
            )));
        }
        let numeric = value.strip_prefix(['-', '+']).unwrap_or(value);
        if numeric.is_empty()
            || numeric.chars().filter(|&c| c == '.').count() > 1
            || numeric.chars().any(|c| !c.is_ascii_digit() && c != '.')
        {
            return Err(AppError::Pipeline(format!(
                "Invalid loudnorm_params format: '{}'. Value for '{}' is not a number",
                params, prefix
            )));
        }
        let parsed: f64 = value.parse().map_err(|_| {
            AppError::Pipeline(format!(
                "Invalid loudnorm_params value for '{}': '{}'",
                prefix, value
            ))
        })?;
        let (lo, hi) = match *prefix {
            "I=" => LOUDNORM_I_RANGE,
            "LRA=" => LOUDNORM_LRA_RANGE,
            _ => LOUDNORM_TP_RANGE,
        };
        if !(lo..=hi).contains(&parsed) {
            return Err(AppError::Pipeline(format!(
                "loudnorm_params value for '{}' out of range ({}..{}): '{}'",
                prefix, lo, hi, value
            )));
        }
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

fn validate_directory_path(path: &str, name: &str) -> Result<(), AppError> {
    sanitize_path(path)?;
    if path.trim().is_empty() {
        return Err(AppError::Pipeline(format!(
            "{} directory path is empty",
            name
        )));
    }
    Ok(())
}

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
    let total = jobs.iter().map(|job| job.timestamps.len()).sum::<usize>();
    if total > MAX_RESUMED_TIMESTAMPS {
        return Err(AppError::Pipeline(format!(
            "Resume state contains too many timestamps: {} > {}",
            total, MAX_RESUMED_TIMESTAMPS
        )));
    }
    for (index, job) in jobs.iter().enumerate() {
        let input = resolve_and_validate_path(&sanitize_path(&job.video.input_path)?, input_roots)
            .map_err(|e| {
                AppError::Pipeline(format!("Resume job {} input path rejected: {}", index, e))
            })?;
        if !input.is_file() {
            return Err(AppError::Pipeline(format!(
                "Resume job {} input is not a file: {}",
                index,
                input.display()
            )));
        }
        let output = resolve_and_validate_path(
            &sanitize_path(&job.video.output_path)?,
            &[output_root.to_path_buf()],
        )
        .map_err(|e| {
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
            || job.error.as_deref().is_some_and(|e| {
                e.chars().count() > MAX_PATH_LEN || e.chars().any(|c| c.is_control())
            })
            || job
                .timestamps
                .iter()
                .any(|t| t.chars().count() > MAX_PATH_LEN || t.chars().any(|c| c.is_control()))
        {
            return Err(AppError::Pipeline(format!(
                "Resume job {} contains an invalid video name",
                index
            )));
        }
        if let Some(thumbnail) = &job.video.thumbnail_path {
            resolve_and_validate_path(&sanitize_path(thumbnail)?, &[thumbnail_root.to_path_buf()])
                .map_err(|e| {
                    AppError::Pipeline(format!(
                        "Resume job {} thumbnail path rejected: {}",
                        index, e
                    ))
                })?;
        }
    }
    Ok(())
}
