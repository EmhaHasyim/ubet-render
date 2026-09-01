use crate::error::AppError;
use crate::models::job::RenderStats;
use crate::models::media::{AudioInfo, LoudnormMeasurement};

/// Minimum supported FFmpeg major/minor version.
pub(crate) const MIN_FFMPEG_VERSION: (u32, u32) = (8, 1);

pub(crate) fn extract_time(line: &str) -> Option<f64> {
    let time_marker = "time=";
    if let Some(start) = line.find(time_marker) {
        let after_time = &line[start + time_marker.len()..];
        let time_val = after_time.split_whitespace().next()?;
        let parts: Vec<&str> = time_val.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let s: f64 = parts[2].parse().ok()?;
            return Some(h * 3600.0 + m * 60.0 + s);
        }
    }
    None
}

/// Strip a trailing unit suffix (e.g. the `kbits/s` in `bitrate=4123.4kbits/s`,
/// or the `x` in `speed=12.3x`) so the bare numeric value can be parsed.
///
/// Only strips ASCII alphabetic suffixes — Unicode alphabetic chars are
/// preserved so edge-case output is not incorrectly truncated.
pub(crate) fn strip_units(tok: &str) -> &str {
    tok.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '/' || c == ':')
}

/// Parses ffmpeg's periodic status line (the `speed=`, `bitrate=` and `fps=`
/// tokens it prints on every progress update) into a [`RenderStats`].
///
/// Returns `None` when none of the three tokens are present, so the caller can
/// cheaply skip non-status lines. Token values are of the form `12.3x`,
/// `4123.4kbits/s` or a plain `29.97`; the trailing unit suffix is stripped
/// before parsing. `N/A` is intentionally unparseable and therefore ignored.
pub(crate) fn parse_stats(line: &str) -> Option<RenderStats> {
    let mut speed = 0.0f64;
    let mut bitrate_kbps = 0.0f64;
    let mut fps = 0.0f64;
    let mut any = false;

    if let Some(idx) = line.find("speed=")
        && let Some(tok) = line[idx + 6..].split_whitespace().next()
        && let Ok(v) = strip_units(tok).parse::<f64>()
    {
        speed = v;
        any = true;
    }
    if let Some(idx) = line.find("bitrate=")
        && let Some(tok) = line[idx + 8..].split_whitespace().next()
        && let Ok(v) = strip_units(tok).parse::<f64>()
    {
        bitrate_kbps = v;
        any = true;
    }
    if let Some(idx) = line.find("fps=")
        && let Some(tok) = line[idx + 4..].split_whitespace().next()
        && let Ok(v) = strip_units(tok).parse::<f64>()
    {
        fps = v;
        any = true;
    }

    if any {
        Some(RenderStats {
            speed,
            bitrate_kbps,
            fps,
        })
    } else {
        None
    }
}

/// Parse an ffprobe r_frame_rate value (fraction "30000/1001" or float "29.97").
pub(crate) fn parse_ffprobe_frame_rate(value: &str) -> Option<f64> {
    if let Some((num, den)) = value.split_once('/') {
        let n: f64 = num.trim().parse().ok()?;
        let d: f64 = den.trim().parse().ok()?;
        if d == 0.0 {
            return None;
        }
        Some((n / d).clamp(1.0, 240.0))
    } else {
        value.parse::<f64>().ok().map(|f| f.clamp(1.0, 240.0))
    }
}

/// Pure JSON→AudioInfo parser extracted from `get_audio_info` so it can be
/// unit-tested without spinning up Tauri + ffprobe. `source_label` is used
/// only to make error messages reference a meaningful path.
pub(crate) fn parse_audio_probe_value(
    stdout: &str,
    source_label: &str,
) -> Result<AudioInfo, AppError> {
    let json: serde_json::Value = serde_json::from_str(stdout).map_err(|e| {
        AppError::Ffmpeg(format!(
            "ffprobe JSON parse failed for '{}': {}",
            source_label, e
        ))
    })?;

    let stream = json
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .ok_or_else(|| AppError::Ffmpeg(format!("No audio stream found in '{}'", source_label)))?;

    let codec = stream
        .get("codec_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let sample_rate = stream
        .get("sample_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| AppError::Ffmpeg(format!("Missing sample_rate in '{}'", source_label)))?;

    let channels = stream
        .get("channels")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| AppError::Ffmpeg(format!("Missing channels in '{}'", source_label)))?
        as u32;

    let bit_rate = stream
        .get("bit_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok());

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or_else(|| AppError::Ffmpeg(format!("Missing duration in '{}'", source_label)))?;

    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(source_label.to_string()));
    }

    Ok(AudioInfo {
        codec,
        sample_rate,
        channels,
        bit_rate,
    })
}

/// Pass 1 of EBU R128 two-pass loudnorm.
///
/// Parses the loudnorm JSON block emitted by FFmpeg.
///
/// Required fields (matching `LoudnormMeasurement`): `input_i`,
/// `input_tp`, `input_lra`, `input_thresh`, `target_offset`. Any missing
/// required field causes `None` so the caller can fall back to single-pass.
pub(crate) fn parse_loudnorm_measurement(text: &str) -> Option<LoudnormMeasurement> {
    let anchor = "\"input_i\"";
    let anchor_idx = text.find(anchor)?;
    let bytes = text.as_bytes();
    // Walk backward from the anchor to find the opening `{` that begins this
    // JSON object. Stop if we walk more than a few thousand characters back,
    // which would indicate the anchor landed in unrelated content.
    let mut start = anchor_idx;
    let max_back = 4096;
    while start > 0 && bytes[start - 1] != b'{' {
        start -= 1;
        if anchor_idx - start > max_back {
            return None;
        }
    }
    if start == 0 && bytes[start] != b'{' {
        return None;
    }
    // The loudnorm JSON has no nested objects / arrays of objects, so the
    // first `}` after the anchor closes the measurement block.
    let rest = &text[anchor_idx..];
    let end_rel = rest.find('}')?;
    let end = anchor_idx + end_rel + 1;
    let slice = &text[start..end];
    let parsed: serde_json::Value = serde_json::from_str(slice).ok()?;
    let obj = parsed.as_object()?;

    let parse_f = |k: &str| -> Option<f64> {
        obj.get(k)
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
    };

    Some(LoudnormMeasurement {
        input_i: parse_f("input_i")?,
        input_tp: parse_f("input_tp")?,
        input_lra: parse_f("input_lra")?,
        input_thresh: parse_f("input_thresh")?,
        target_offset: parse_f("target_offset")?,
    })
}

/// Some static builds prefix the version with `n` (e.g. `n8.1.1`); that prefix
/// is stripped before parsing. Returns `None` if the version can't be parsed.
pub(crate) fn parse_ffmpeg_version(line: &str, prefix: &str) -> Option<(u32, u32)> {
    let rest = line.split(prefix).nth(1)?;
    let token = rest.split_whitespace().next()?;
    // Static builds commonly prefix the version with 'n' (e.g. `n8.1.1`).
    let token = token.strip_prefix('n').unwrap_or(token);
    let mut parts = token.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

pub(crate) fn version_meets_minimum(version: (u32, u32)) -> bool {
    let (min_major, min_minor) = MIN_FFMPEG_VERSION;
    version.0 > min_major || (version.0 == min_major && version.1 >= min_minor)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // strip_units
    // -----------------------------------------------------------------------

    #[test]
    fn test_strip_units_removes_kbits_suffix() {
        assert_eq!(strip_units("4123.4kbits/s"), "4123.4");
    }

    #[test]
    fn test_strip_units_removes_x_suffix() {
        assert_eq!(strip_units("12.3x"), "12.3");
    }

    #[test]
    fn test_strip_units_removes_k_suffix() {
        assert_eq!(strip_units("5000k"), "5000");
    }

    #[test]
    fn test_strip_units_preserves_bare_number() {
        assert_eq!(strip_units("29.97"), "29.97");
    }

    #[test]
    fn test_strip_units_does_not_strip_unicode() {
        assert_eq!(strip_units("123abc"), "123");
    }

    #[test]
    fn test_strip_units_empty() {
        assert_eq!(strip_units(""), "");
    }

    // -----------------------------------------------------------------------
    // extract_time
    // -----------------------------------------------------------------------

    #[test]
    fn test_extract_time_standard_format() {
        let result = extract_time("time=01:23:45.67");
        assert!(result.is_some());
        let expected = 1.0 * 3600.0 + 23.0 * 60.0 + 45.67;
        assert!((result.unwrap() - expected).abs() < 0.01);
    }

    #[test]
    fn test_extract_time_no_match() {
        assert!(extract_time("frame=  120 fps=30").is_none());
    }

    #[test]
    fn test_extract_time_with_surrounding_text() {
        let result = extract_time("frame=  120 fps=30.0 time=00:05:30.00 bitrate=1234.5kbits/s");
        assert!(result.is_some());
        assert!((result.unwrap() - 330.0).abs() < 0.01);
    }

    #[test]
    fn test_extract_time_invalid_parts() {
        assert!(extract_time("time=ab:cd:ef").is_none());
    }

    // -----------------------------------------------------------------------
    // parse_stats
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_stats_all_fields() {
        let line = "frame=  120 fps=30.0 speed=12.5x bitrate=4123.4kbits/s";
        let stats = parse_stats(line);
        assert!(stats.is_some());
        let s = stats.unwrap();
        assert!((s.speed - 12.5).abs() < 0.01);
        assert!((s.bitrate_kbps - 4123.4).abs() < 0.01);
        assert!((s.fps - 30.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_stats_partial_speed_only() {
        let line = "speed=2.0x";
        let stats = parse_stats(line);
        assert!(stats.is_some());
        let s = stats.unwrap();
        assert!((s.speed - 2.0).abs() < 0.01);
        assert!((s.bitrate_kbps - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_stats_no_match() {
        let line = "frame=  120 duration=00:01:00";
        assert!(parse_stats(line).is_none());
    }

    #[test]
    fn test_parse_stats_empty() {
        assert!(parse_stats("").is_none());
    }

    // -----------------------------------------------------------------------
    // parse_ffprobe_frame_rate
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_ffprobe_frame_rate_fraction() {
        let result = parse_ffprobe_frame_rate("30000/1001");
        assert!(result.is_some());
        assert!((result.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_float() {
        let result = parse_ffprobe_frame_rate("29.97");
        assert!(result.is_some());
        assert!((result.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_invalid() {
        assert!(parse_ffprobe_frame_rate("invalid").is_none());
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_zero_denominator() {
        assert!(parse_ffprobe_frame_rate("1/0").is_none());
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_clamped() {
        let result = parse_ffprobe_frame_rate("1000");
        assert!(result.is_some());
        assert!((result.unwrap() - 240.0).abs() < 0.01);
    }

    // -----------------------------------------------------------------------
    // parse_ffmpeg_version
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_ffmpeg_version_standard() {
        let result =
            parse_ffmpeg_version("ffmpeg version 8.1.1-essentials_build", "ffmpeg version ");
        assert_eq!(result, Some((8, 1)));
    }

    #[test]
    fn test_parse_ffmpeg_version_n_prefix() {
        let result = parse_ffmpeg_version("ffprobe version n8.2.0", "ffprobe version ");
        assert_eq!(result, Some((8, 2)));
    }

    #[test]
    fn test_parse_ffmpeg_version_no_match() {
        let result = parse_ffmpeg_version("unexpected output", "ffmpeg version ");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_ffmpeg_version_minor_only() {
        let result = parse_ffmpeg_version("ffmpeg version 7.0", "ffmpeg version ");
        assert_eq!(result, Some((7, 0)));
    }

    // -----------------------------------------------------------------------
    // version_meets_minimum
    // -----------------------------------------------------------------------

    #[test]
    fn test_version_meets_minimum_exact_match() {
        assert!(version_meets_minimum((8, 1)));
    }

    #[test]
    fn test_version_meets_minimum_above() {
        assert!(version_meets_minimum((8, 2)));
        assert!(version_meets_minimum((9, 0)));
    }

    #[test]
    fn test_version_meets_minimum_below() {
        assert!(!version_meets_minimum((8, 0)));
        assert!(!version_meets_minimum((7, 5)));
    }

    #[test]
    fn test_version_meets_minimum_major_above() {
        assert!(version_meets_minimum((10, 0)));
    }
}
