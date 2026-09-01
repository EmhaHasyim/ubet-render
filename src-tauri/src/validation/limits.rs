//! Validation limits shared across the whole backend.
//!
//! These values mirror `src/core/schema.ts` and
//! `src/core/config-contract.json`.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_limits_match_frontend_contract() {
        // Keep the contract in the repository root as the cross-language
        // source of truth. `CARGO_MANIFEST_DIR` points at `src-tauri`.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/core/config-contract.json");
        let contract: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display())),
        )
        .expect("config contract must be valid JSON");
        let limits = contract.get("limits").expect("contract must define limits");
        let number = |name: &str| -> f64 {
            limits
                .get(name)
                .and_then(serde_json::Value::as_f64)
                .unwrap_or_else(|| panic!("contract limit {name} must be numeric"))
        };
        let range = |name: &str| -> (f64, f64) {
            let value = limits.get(name).expect("range limit must exist");
            (
                value
                    .get("min")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap(),
                value
                    .get("max")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap(),
            )
        };

        assert_eq!(
            range("bitrateK"),
            (MIN_BITRATE_K as f64, MAX_BITRATE_K as f64)
        );
        assert_eq!(
            range("songsPerPlaylist"),
            (MIN_SONGS_PER_PLAYLIST as f64, MAX_SONGS_PER_PLAYLIST as f64)
        );
        assert_eq!(
            range("durationHours"),
            (MIN_DURATION_HOURS, MAX_DURATION_HOURS)
        );
        assert_eq!(
            range("loopCount"),
            (MIN_LOOP_COUNT as f64, MAX_LOOP_COUNT as f64)
        );
        assert_eq!(
            range("sampleRate"),
            (MIN_SAMPLE_RATE as f64, MAX_SAMPLE_RATE as f64)
        );
        assert_eq!(range("concurrentPrep"), (1.0, MAX_CONCURRENT_PREP as f64));
        assert_eq!(range("paddingSec"), (0.0, MAX_PADDING_SEC as f64));
        assert_eq!(number("maxSourceFiles"), MAX_SOURCE_FILES as f64);
        assert_eq!(number("maxResumeStateBytes"), MAX_RESUME_STATE_BYTES as f64);
        assert_eq!(
            number("maxResumedTimestamps"),
            MAX_RESUMED_TIMESTAMPS as f64
        );
        assert_eq!(number("maxPrefixLength"), MAX_PREFIX_LEN as f64);
        assert_eq!(number("maxPathLength"), MAX_PATH_LEN as f64);
    }
}
