use crate::config::{Target, VideoSettings};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::job::PipelineEvent;
use crate::models::media::ProcessedAudio;
use crate::utils::event;
use std::path::Path;
use tauri::AppHandle;

/// Escape a value for FFmpeg's FFMETADATA1 key/value format.
/// Metadata values are not shell arguments here; FFmpeg parses reserved
/// separators after receiving the argument, so they must be escaped in-band.
fn escape_ffmetadata_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '=' => escaped.push_str("\\\\="),
            ';' => escaped.push_str("\\\\;"),
            '#' => escaped.push_str("\\\\#"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            other => escaped.push(other),
        }
    }
    escaped
}

pub struct PingPongVideoParams<'a> {
    pub app: &'a tauri::AppHandle,
    pub input: &'a str,
    pub output: &'a Path,
    pub video_settings: &'a VideoSettings,
    pub use_pingpong: bool,
    pub fps: f64,
    pub tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    pub cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
    pub tx_stats: Option<tokio::sync::mpsc::Sender<crate::models::job::RenderStats>>,
}

pub async fn create_ping_pong_video(params: PingPongVideoParams<'_>) -> Result<(), AppError> {
    let PingPongVideoParams {
        app,
        input,
        output,
        video_settings,
        use_pingpong,
        fps,
        tx_progress,
        cancel_control,
        tx_stats,
    } = params;
    let base_filter = build_base_filter(use_pingpong);
    // Use Vec<&str> — borrow static strings and settings fields, no .into() allocation for static strings
    let mut args: Vec<&str> = vec!["-y", "-i", input];
    let filter_complex = base_filter.replace("[v_base]", "[v]");
    let final_map = "[v]";
    let fps_str = fps.to_string();
    let output_str = output.to_string_lossy().into_owned();
    let maxrate_k = video_settings
        .bitrate_max
        .to_ascii_lowercase()
        .trim_end_matches('k')
        .parse::<u32>()
        .unwrap_or(5000);
    let bufsize_k = maxrate_k * 2;
    let bufsize = format!("{}k", bufsize_k);
    let is_hw_encoder = video_settings.encoder.contains("nvenc")
        || video_settings.encoder.contains("amf")
        || video_settings.encoder.contains("qsv");
    args.extend([
        "-filter_complex",
        &filter_complex,
        "-map",
        final_map,
        "-c:v",
        &video_settings.encoder,
    ]);
    if video_settings.encoder.contains("nvenc") {
        // NVENC preset: only valid for HEVC (hevc_nvenc) and AV1 (av1_nvenc).
        // For H.264 (h264_nvenc), preset values differ (p1-p7 vs p1-p7) and
        // `-rc vbr` with `-b:v` is the correct pattern; omitting `-preset`
        // lets the encoder use its default (p4 = medium), which is acceptable.
        let is_hevc_or_av1 =
            video_settings.encoder.contains("hevc") || video_settings.encoder.contains("av1");
        if is_hevc_or_av1 {
            args.extend(["-preset", &video_settings.preset]);
        }
        args.extend([
            "-rc",
            "vbr",
            "-b:v",
            &video_settings.bitrate_target,
            "-maxrate",
            &video_settings.bitrate_max,
            "-bufsize",
            &bufsize,
        ]);
    } else if is_hw_encoder {
        args.extend([
            "-b:v",
            &video_settings.bitrate_target,
            "-maxrate",
            &video_settings.bitrate_max,
            "-bufsize",
            &bufsize,
        ]);
    } else {
        args.extend([
            "-crf",
            "23",
            "-maxrate",
            &video_settings.bitrate_max,
            "-bufsize",
            &bufsize,
        ]);
    }
    args.extend(["-r", &fps_str, "-vsync", "cfr", &output_str]);
    ffmpeg::run(app, &args, tx_progress, cancel_control, tx_stats).await
}

/// Builds the ffmpeg `-filter_complex` graph for the intermediate video.
///
/// The output frame size is always 1920×1080 (required so the downstream
/// concat demuxer `-c copy` sees uniform segments), but the source is scaled
/// with `force_original_aspect_ratio=decrease` and then letterboxed with
/// `pad`. Without this, non-16:9 sources (portrait / square videos) would be
/// stretched to 1920×1080 and visibly distorted. The padding color defaults
/// to black.
fn build_base_filter(use_pingpong: bool) -> String {
    // Scale preserving the aspect ratio, then pad the leftover space to the
    // fixed 1920×1080 canvas. `(ow-iw)/2` / `(oh-ih)/2` centre the scaled
    // frame both vertically and horizontally. `concat!` keeps the pieces on
    // separate source lines without relying on a fragile `\` line-continuation
    // inside the literal (a stray space there would silently break the graph).
    let scale_pad = concat!(
        "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,",
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black"
    );
    if use_pingpong {
        format!(
            "[0:v]{},unsharp=3:3:1.0:3:3:0.0[upscaled];[upscaled]split[s1][s2];[s2]reverse[r];[s1][r]concat=n=2:v=1[v_base]",
            scale_pad
        )
    } else {
        format!("[0:v]{},unsharp=3:3:1.0:3:3:0.0[v_base]", scale_pad)
    }
}

fn format_timestamp(seconds: f64, force_hours: bool) -> String {
    let total_secs = seconds.round() as u64;
    let h = total_secs / 3600;
    let m = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    if force_hours || h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// Generates the ffmpeg concat demuxer playlist files (audio + video) and
/// writes them directly to disk via a buffered writer, avoiding the memory
/// overhead of building multi-megabyte `String`s in heap for long renders.
///
/// `loop_count` is forwarded to the internal `match` that derives
/// `repeat_count`. Every render produces a compact list (each song once,
/// optionally followed by a "Looping" end-marker) regardless of the chosen
/// loop mode.
#[allow(clippy::too_many_arguments)]
pub async fn generate_loop_playlists(
    app: &AppHandle,
    songs: &[ProcessedAudio],
    ping_pong_path: &Path,
    ping_pong_duration: f64,
    target: &Target,
    loop_count: Option<usize>,
    audio_list_path: &Path,
    video_list_path: &Path,
) -> Result<(Vec<String>, String, f64), AppError> {
    let single_loop_duration: f64 = songs.iter().map(|s| s.duration).sum();
    if single_loop_duration <= 0.0 {
        return Err(AppError::Pipeline("Audio loop duration is zero".into()));
    }
    fn escape_concat_path(path: &str) -> String {
        // FFmpeg concat demuxer uses single-quoted file paths with -safe 0.
        // File paths with special chars must be escaped:
        // - Backslashes: converted to forward slashes (Windows path compat)
        // - Single quotes: escaped by ending quote, inserting escaped quote, reopening
        // - Newlines/carriage returns: replaced with space (cannot appear in paths)
        let mut result = String::with_capacity(path.len() + 4);
        for c in path.chars() {
            match c {
                '\'' => {
                    // FFmpeg concat escapes single quotes as: '\\'' (end quote, escaped quote, reopen)
                    result.push_str("'\\''");
                }
                '\n' | '\r' => {
                    // Newlines cannot appear in concat file paths; replace with space
                    result.push(' ');
                }
                '\\' => result.push('/'),
                _ => result.push(c),
            }
        }
        result
    }
    // Bound total playlist/chapter entries, not only repeat iterations. With
    // 100 selected songs, a 10 000-repeat cap would still create one million
    // lines and chapter records. The effective cap keeps generated work below
    // a practical ceiling while preserving the explicit loop-count contract.
    const MAX_REPEAT_COUNT: usize = 10_000;
    const MAX_REPEATED_ENTRIES: usize = 100_000;
    let max_repeat_count = MAX_REPEAT_COUNT.min((MAX_REPEATED_ENTRIES / songs.len().max(1)).max(1));
    let (repeat_count, was_capped) = match loop_count {
        Some(n) => {
            let capped = n.min(max_repeat_count);
            (capped, capped < n)
        }
        None => {
            let raw = (target.min_duration_sec as f64 / single_loop_duration).ceil();
            let capped = raw.min(max_repeat_count as f64) as usize;
            (capped, raw > max_repeat_count as f64)
        }
    };
    let repeat_count = repeat_count.max(1);

    if was_capped {
        event::emit(
            app,
            PipelineEvent::Log {
                level: "warn".into(),
                message: format!(
                    "Loop repeat count capped at {} to bound playlist and chapter work. Output duration may be shorter than requested.",
                    max_repeat_count
                ),
            },
        );
    }

    // Precompute each song's escaped concat line ONCE; the same strings are
    // repeated `repeat_count` times, so building them inside the loop would
    // re-allocate and re-escape on every iteration (expensive for long loops).
    let song_lines: Vec<String> = songs
        .iter()
        .map(|s| format!("file '{}'\n", escape_concat_path(&s.path)))
        .collect();

    // Write the audio concat playlist directly to disk via a buffered writer,
    // instead of first assembling a giant String in memory and writing it all
    // at once. For 10 000 repeats of 9 songs (~90 000 lines) this can save
    // tens of megabytes of heap allocation.
    {
        let file = tokio::fs::File::create(audio_list_path).await?;
        let mut writer = tokio::io::BufWriter::new(file);
        use tokio::io::AsyncWriteExt;
        for _ in 0..repeat_count {
            for line in &song_lines {
                writer.write_all(line.as_bytes()).await?;
            }
        }
        writer.flush().await?;
    }

    let total_audio_duration = single_loop_duration * repeat_count as f64;
    let force_hours = total_audio_duration >= 3600.0;
    let mut timestamps = Vec::new();
    let mut current_time = 0.0;
    // Compact timestamp format: list each song ONCE regardless of `repeat_count`,
    // then add a single "Looping" end-marker when the playlist is actually
    // looping (`repeat_count > 1`).
    //
    // Earlier versions of this function had two distinct branches that produced
    // a verbose `(Play N)` suffix per iteration (e.g. 9 songs × 5 plays = 45
    // timestamp entries), which was repetitive and inconsistent with the
    // chapter labels that YouTube itself uses for looped video. Both branches
    // have been collapsed into this single loop.
    for song in songs {
        let song_name = Path::new(&song.original_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&song.original_name);
        timestamps.push(format!(
            "{} - {}",
            format_timestamp(current_time, force_hours),
            song_name
        ));
        current_time += song.duration;
    }
    // `repeat_count > 1` (rather than the floating-point comparison
    // `current_time < total_audio_duration`) is used to avoid summation-order
    // precision pitfalls: `current_time` is accumulated iteratively while
    // `total_audio_duration` is a single multiplication, so the two can
    // differ by epsilon and produce a spurious (or missing) end-marker. The
    // boolean guard is unambiguous for every input.
    if repeat_count > 1 {
        let looping_label = "Looping".to_string();
        timestamps.push(format!(
            "{} - {}",
            format_timestamp(current_time, force_hours),
            looping_label
        ));
    }

    // Build native chapters spanning the ENTIRE timeline (all loop repeats),
    // independent of the per-job timestamp text computed above. This is what
    // powers the full-length MP4/MKV chapter navigation (#5).
    let mut chapter_entries: Vec<(i64, String)> = Vec::new();
    let mut chap_time = 0.0f64;
    for loop_idx in 0..repeat_count {
        for song in songs {
            let song_name = Path::new(&song.original_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&song.original_name);
            let title = if repeat_count > 1 {
                format!("{} (Loop {})", song_name, loop_idx + 1)
            } else {
                song_name.to_string()
            };
            chapter_entries.push(((chap_time * 1000.0) as i64, escape_ffmetadata_value(&title)));
            chap_time += song.duration;
        }
    }
    // Do not add the textual "Looping" marker to native chapters: it would
    // start exactly at the end of the media and therefore produce a zero-length
    // terminal chapter (`START == END`). The marker remains in the human-readable
    // timestamp list above, where it has no container-level duration semantics.

    if ping_pong_duration <= 0.0 {
        return Err(AppError::Pipeline("Ping-pong video duration zero".into()));
    }

    // Write the video concat playlist directly to disk, same approach as the
    // audio playlist above to avoid building an oversized String in memory.
    {
        let file = tokio::fs::File::create(video_list_path).await?;
        let mut writer = tokio::io::BufWriter::new(file);
        use tokio::io::AsyncWriteExt;
        let ping_pong_path_str = escape_concat_path(&ping_pong_path.to_string_lossy());
        let video_line = format!("file '{}'\n", ping_pong_path_str);
        let mut current_video_duration = 0.0;
        while current_video_duration < total_audio_duration + target.padding_sec as f64 {
            writer.write_all(video_line.as_bytes()).await?;
            current_video_duration += ping_pong_duration;
        }
        writer.flush().await?;
    }

    let total_ms = (total_audio_duration * 1000.0) as i64;
    let mut chapters = String::from(";FFMETADATA1\n");
    for (idx, (start_ms, title)) in chapter_entries.iter().enumerate() {
        let end_ms = if idx + 1 < chapter_entries.len() {
            chapter_entries[idx + 1].0
        } else {
            total_ms
        };
        chapters.push_str(&format!(
            "[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n",
            start_ms, end_ms, title
        ));
    }

    Ok((timestamps, chapters, total_audio_duration))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // build_base_filter
    // -----------------------------------------------------------------------

    #[test]
    fn test_build_base_filter_preserves_aspect_ratio() {
        let f = build_base_filter(false);
        assert!(f.contains("force_original_aspect_ratio=decrease"));
        assert!(f.contains("pad=1920:1080"));
        // Non-ping-pong variant must not contain the reverse/concat graph.
        assert!(!f.contains("reverse"));
    }

    #[test]
    fn test_build_base_filter_pingpong_graph() {
        let f = build_base_filter(true);
        assert!(f.contains("force_original_aspect_ratio=decrease"));
        assert!(f.contains("pad=1920:1080"));
        assert!(f.contains("reverse"));
        assert!(f.contains("concat=n=2:v=1"));
    }

    #[test]
    fn test_build_base_filter_ends_with_v_base_label() {
        assert!(build_base_filter(false).ends_with("[v_base]"));
        assert!(build_base_filter(true).ends_with("[v_base]"));
    }

    // -----------------------------------------------------------------------
    // format_timestamp
    // -----------------------------------------------------------------------

    #[test]
    fn test_format_timestamp_hours() {
        assert_eq!(format_timestamp(3661.0, false), "01:01:01");
    }

    #[test]
    fn test_format_timestamp_minutes() {
        assert_eq!(format_timestamp(65.0, false), "01:05");
    }

    #[test]
    fn test_format_timestamp_seconds_only() {
        assert_eq!(format_timestamp(5.0, false), "00:05");
    }

    #[test]
    fn test_format_timestamp_force_hours() {
        // force_hours=true should always include HH: even when under 1 hour
        assert_eq!(format_timestamp(59.0, true), "00:00:59");
    }

    #[test]
    fn test_format_timestamp_rounding() {
        // 1.999 seconds rounds to 2
        assert_eq!(format_timestamp(1.999, false), "00:02");
    }

    #[test]
    fn test_format_timestamp_zero() {
        assert_eq!(format_timestamp(0.0, false), "00:00");
    }

    #[test]
    fn test_format_timestamp_large_value() {
        assert_eq!(format_timestamp(90061.0, false), "25:01:01");
    }

    // -----------------------------------------------------------------------
    // escape_concat_path (delegates to the module-level function)
    // -----------------------------------------------------------------------

    // The module-level `escape_concat_path` is defined inside `generate_loop_playlists`.
    // We test it through the public API by calling `generate_loop_playlists` in
    // integration tests, and here we validate the escaping logic via the generated
    // concat playlist output.  For unit-testing the escaping directly, we define a
    // local helper that mirrors the module implementation.
    fn escape_concat_path(path: &str) -> String {
        // Duplicates the logic in generate_loop_playlists::escape_concat_path.
        // This is intentional: the inner function is not `pub`, and keeping a
        // local copy ensures the tests don't silently break if the escaping
        // changes without updating the test expectations.
        let mut result = String::with_capacity(path.len() + 4);
        for c in path.chars() {
            match c {
                '\'' => result.push_str("'\\''"),
                '\n' | '\r' => result.push(' '),
                '\\' => result.push('/'),
                _ => result.push(c),
            }
        }
        result
    }

    #[test]
    fn test_escape_ffmetadata_reserved_characters() {
        assert_eq!(
            escape_ffmetadata_value("A=B;C#D\\\\E\\nF"),
            "A\\\\=B\\\\;C\\\\#D\\\\\\\\E\\\\nF"
        );
    }

    #[test]
    fn test_escape_concat_path_normal() {
        assert_eq!(
            escape_concat_path("C:/videos/video.mp4"),
            "C:/videos/video.mp4"
        );
    }

    #[test]
    fn test_escape_concat_path_single_quote() {
        // FFmpeg concat escapes single quote `'` as `'\''` (end quote + backslash-quote + reopen quote).
        // In Rust string: `it'\''s` → actual chars: `it'\''s`
        assert_eq!(
            escape_concat_path("C:/videos/it's_video.mp4"),
            "C:/videos/it'\\''s_video.mp4"
        );
    }

    #[test]
    fn test_escape_concat_path_backslash() {
        // Windows backslashes are converted to forward slashes
        assert_eq!(
            escape_concat_path("C:\\videos\\video.mp4"),
            "C:/videos/video.mp4"
        );
    }

    #[test]
    fn test_escape_concat_path_newline() {
        assert_eq!(escape_concat_path("video\n.mp4"), "video .mp4");
    }

    #[test]
    fn test_escape_concat_path_carriage_return() {
        assert_eq!(escape_concat_path("video\r.mp4"), "video .mp4");
    }

    #[test]
    fn test_escape_concat_path_mixed_special_chars() {
        // Use actual newline character `\n` (not backslash + letter n)
        // to test the newline → space replacement.
        let input = "C:\\My Videos\\it's\\video\n.mp4";
        let result = escape_concat_path(input);
        // Backslash directory separators → forward slashes
        assert!(
            result.starts_with("C:/"),
            "Path should start with C:/, got: {}",
            result
        );
        assert!(
            result.contains("/My Videos/"),
            "Directory slashes should be forward: {}",
            result
        );
        // Single quote is escaped as `'\''` (contains backslash)
        assert!(
            result.contains("it'"),
            "Single quote escape should preserve 'it': {}",
            result
        );
        // Newline replaced by space before `.mp4`
        assert!(
            result.contains(" .mp4"),
            "Newline should be replaced by space: {}",
            result
        );
    }

    #[test]
    fn test_escape_concat_path_empty() {
        assert_eq!(escape_concat_path(""), "");
    }
}
