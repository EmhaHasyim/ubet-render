//! Validation limits shared across the whole backend.
//!
//! These values mirror `src/core/schema.ts` (`CONFIG_LIMITS`).

pub const MAX_BITRATE_K: u32 = 50000;
pub const MIN_BITRATE_K: u32 = 100;
pub const MAX_SONGS_PER_PLAYLIST: usize = 100;
pub const MIN_SONGS_PER_PLAYLIST: usize = 1;
pub const MAX_DURATION_HOURS: f64 = 24.0;
pub const MIN_DURATION_HOURS: f64 = 0.1;
pub const MAX_TARGET_DURATION_SEC: u64 = (MAX_DURATION_HOURS as u64) * 3600;
pub const MAX_LOOP_COUNT: usize = 100;
pub const MIN_LOOP_COUNT: usize = 1;
pub const MIN_SAMPLE_RATE: u32 = 8_000;
pub const MAX_SAMPLE_RATE: u32 = 192_000;
pub const MAX_CONCURRENT_PREP: usize = 64;
pub const MAX_PADDING_SEC: u64 = 86_400;
pub const MAX_SOURCE_FILES: usize = 10_000;
pub const MAX_RESUME_STATE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_RESUMED_TIMESTAMPS: usize = 100_000;
pub const MAX_PREFIX_LEN: usize = 100;
pub const MAX_PATH_LEN: usize = 4096;

pub const VALID_ENCODERS: &[&str] = &[
    "libx264",
    "h264_nvenc",
    "h264_amf",
    "h264_qsv",
    "libx265",
    "hevc_nvenc",
    "hevc_amf",
    "hevc_qsv",
    "libaom-av1",
    "svt-av1",
    "av1_nvenc",
    "av1_amf",
    "av1_qsv",
    "av1_mf",
    "av1_vaapi",
    "av1_v4l2m2m",
    "libsvtav1",
];

/// Canonical Windows reserved device names (stem, upper-cased).
/// Single source of truth — use from `path` and `estimator` instead of
/// duplicating the list.
pub const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "NUL", "PRN", "AUX", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Canonical loudnorm target used when the frontend omits it.
/// Mirrors `LOUDNORM_PARAMS` in `src/core/config.ts`.
pub const LOUDNORM_DEFAULT: &str = "I=-14:LRA=11:TP=-1";

/// Bounds for parsed loudnorm values (dB). Rejects absurd targets like
/// `I=-1000` that pass syntax checks but fail late inside FFmpeg.
pub const LOUDNORM_I_RANGE: (f64, f64) = (-70.0, 0.0);
pub const LOUDNORM_LRA_RANGE: (f64, f64) = (1.0, 50.0);
pub const LOUDNORM_TP_RANGE: (f64, f64) = (-9.0, 0.0);

/// Max frontend log entries accepted per `log_to_file` call (DoS guard).
pub const MAX_FRONTEND_LOG_BATCH: usize = 100;
