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

#[cfg(test)]
mod ts_limit_mirror {
    //! Drift guard: `src/core/schema.ts` (`CONFIG_LIMITS`) mirrors the numeric
    //! bounds and `src/core/config.ts` mirrors `LOUDNORM_DEFAULT` (see the
    //! "mirrored by Rust" comments). Reading the TS files at compile time means
    //! a change on either side fails `cargo test`.

    use super::*;

    const TS_SCHEMA: &str = include_str!("../../../src/core/schema.ts");
    const TS_CONFIG: &str = include_str!("../../../src/core/config.ts");

    /// Parse `key: { min: X, max: Y }` out of CONFIG_LIMITS.
    fn ts_range(source: &str, key: &str) -> (f64, f64) {
        let marker = format!("{}: {{", key);
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("CONFIG_LIMITS `{}` not found", key));
        let body_start = start + marker.len();
        let body_end = body_start + source[body_start..].find('}').expect("unterminated range");
        let body = &source[body_start..body_end];
        (number_after(body, "min:"), number_after(body, "max:"))
    }

    /// Parse `key: VALUE` (a scalar member of CONFIG_LIMITS).
    fn ts_scalar(source: &str, key: &str) -> f64 {
        let marker = format!("{}: ", key);
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("CONFIG_LIMITS `{}` not found", key));
        number_after(&source[start + marker.len()..], "")
    }

    /// Parse the leading decimal of `text`, optionally after `marker`.
    fn number_after(text: &str, marker: &str) -> f64 {
        let hay = if marker.is_empty() {
            text
        } else {
            let pos = text
                .find(marker)
                .unwrap_or_else(|| panic!("`{}` not found", marker));
            &text[pos + marker.len()..]
        };
        let trimmed = hay.trim_start();
        let digits: String = trimmed
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        digits.parse().expect("numeric literal")
    }

    #[test]
    fn bitrate_bounds_match_schema() {
        let (min, max) = ts_range(TS_SCHEMA, "bitrateK");
        assert_eq!(min, MIN_BITRATE_K as f64);
        assert_eq!(max, MAX_BITRATE_K as f64);
    }

    #[test]
    fn song_limits_match_schema() {
        let (min, max) = ts_range(TS_SCHEMA, "songsPerPlaylist");
        assert_eq!(min, MIN_SONGS_PER_PLAYLIST as f64);
        assert_eq!(max, MAX_SONGS_PER_PLAYLIST as f64);
    }

    #[test]
    fn duration_hours_match_schema() {
        let (min, max) = ts_range(TS_SCHEMA, "durationHours");
        assert_eq!(min, MIN_DURATION_HOURS);
        assert_eq!(max, MAX_DURATION_HOURS);
    }

    #[test]
    fn loop_count_limits_match_schema() {
        let (min, max) = ts_range(TS_SCHEMA, "loopCount");
        assert_eq!(min, MIN_LOOP_COUNT as f64);
        assert_eq!(max, MAX_LOOP_COUNT as f64);
    }

    #[test]
    fn sample_rate_limits_match_schema() {
        let (min, max) = ts_range(TS_SCHEMA, "sampleRate");
        assert_eq!(min, MIN_SAMPLE_RATE as f64);
        assert_eq!(max, MAX_SAMPLE_RATE as f64);
    }

    #[test]
    fn concurrency_and_padding_max_match_schema() {
        let (_, max) = ts_range(TS_SCHEMA, "concurrentPrep");
        assert_eq!(max, MAX_CONCURRENT_PREP as f64);
        let (_, max) = ts_range(TS_SCHEMA, "paddingSec");
        assert_eq!(max, MAX_PADDING_SEC as f64);
    }

    #[test]
    fn scalar_limits_match_schema() {
        assert_eq!(
            ts_scalar(TS_SCHEMA, "maxSourceFiles"),
            MAX_SOURCE_FILES as f64
        );
        assert_eq!(
            ts_scalar(TS_SCHEMA, "maxResumedTimestamps"),
            MAX_RESUMED_TIMESTAMPS as f64
        );
        assert_eq!(
            ts_scalar(TS_SCHEMA, "maxPrefixLength"),
            MAX_PREFIX_LEN as f64
        );
        assert_eq!(ts_scalar(TS_SCHEMA, "maxPathLength"), MAX_PATH_LEN as f64);
    }

    #[test]
    fn loudnorm_default_matches_ts() {
        let marker = "LOUDNORM_PARAMS = '";
        let start = TS_CONFIG
            .find(marker)
            .expect("LOUDNORM_PARAMS not found in config.ts");
        let rest = &TS_CONFIG[start + marker.len()..];
        let end = rest.find('\'').expect("unterminated LOUDNORM_PARAMS");
        assert_eq!(&rest[..end], LOUDNORM_DEFAULT);
    }
}
