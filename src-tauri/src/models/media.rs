use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedAudio {
    pub path: String,
    pub duration: f64,
    pub original_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFile {
    pub name: String,
    pub input_path: String,
    pub output_path: String,
    pub thumbnail_path: Option<String>,
}

/// Source-audio metadata returned by `ffmpeg::get_audio_info`.
///
/// Used by `audio_pool` to decide between three encoding strategies:
/// 1. **Smart-skip** (`-c copy`) — when the source already matches the target
///    pipeline (AAC, same sample rate, exactly 2 channels, and a known
///    bitrate that does not exceed the requested one).
/// 2. **Two-pass loudnorm** — when the user asked for YouTube-Music-grade
///    normalization AND the source is not smart-skip-eligible.
/// 3. **Plain re-encode** — the historical single-pass fallback.
///
/// `bit_rate` is intentionally `Option<u32>` because many AAC sources
/// (especially .m4a with VBR) report `N/A` for `bit_rate`; the consumer
/// treats `None` as "cannot compare, fall through to re-encode".
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_rate: Option<u32>,
}

/// Subset of FFmpeg's `loudnorm` JSON print-format we actually consume.
///
/// The five fields below are what pass 2 of FFmpeg's EBU R128 loudnorm
/// filter requires to apply accurate, two-pass normalization.  All values
/// are stored as `f64` because the JSON comes back as decimal strings
/// (e.g. `"-23.81"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoudnormMeasurement {
    pub input_i: f64,
    pub input_tp: f64,
    pub input_lra: f64,
    pub input_thresh: f64,
    pub target_offset: f64,
}
