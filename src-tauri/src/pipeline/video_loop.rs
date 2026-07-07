use crate::config::{Target, VideoSettings};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::ProcessedAudio;
use std::path::Path;

pub struct PingPongVideoParams<'a> {
    pub app: &'a tauri::AppHandle,
    pub input: &'a str,
    pub output: &'a Path,
    pub video_settings: &'a VideoSettings,
    pub use_pingpong: bool,
    pub watermark_path: Option<&'a String>,
    pub watermark_opacity: f32,
    pub tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    pub cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
}

pub async fn create_ping_pong_video(params: PingPongVideoParams<'_>) -> Result<(), AppError> {
    let PingPongVideoParams {
        app,
        input,
        output,
        video_settings,
        use_pingpong,
        watermark_path,
        watermark_opacity,
        tx_progress,
        cancel_control,
    } = params;
    let base_filter = if use_pingpong {
        "[0:v]scale=1920:1080:flags=lanczos,unsharp=3:3:1.0:3:3:0.0[upscaled];[upscaled]split[s1][s2];[s2]reverse[r];[s1][r]concat=n=2:v=1[v_base]"
    } else {
        "[0:v]scale=1920:1080:flags=lanczos,unsharp=3:3:1.0:3:3:0.0[v_base]"
    };
    // Use Vec<&str> — borrow static strings and settings fields, no .into() allocation for static strings
    let mut args: Vec<&str> = vec!["-y", "-i", input];
    let (final_map, filter_complex) = if let Some(wm) = watermark_path {
        args.extend(["-i", wm.as_str()]);
        (
            "[v]",
            format!(
                "{};[1:v]format=rgba,colorchannelmixer=aa={}[wm];[v_base][wm]overlay=W-w-20:H-h-20[v]",
                base_filter, watermark_opacity
            ),
        )
    } else {
        ("[v]", base_filter.replace("[v_base]", "[v]"))
    };
    let fps_str = video_settings.fps.to_string();
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
        args.extend([
            "-preset",
            &video_settings.preset,
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
    ffmpeg::run(app, &args, tx_progress, cancel_control).await
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

pub async fn generate_loop_playlists(
    songs: &[ProcessedAudio],
    ping_pong_path: &Path,
    ping_pong_duration: f64,
    target: &Target,
    loop_count: Option<usize>,
    youtube_timestamps: bool,
) -> Result<(String, String, Vec<String>, f64), AppError> {
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
                    // FFmpeg concat escapes single quotes as: '\'' (end quote, escaped quote, reopen)
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
    let repeat_count = match loop_count {
        Some(n) => n,
        None => (target.min_duration_sec as f64 / single_loop_duration).ceil() as usize,
    };
    let repeat_count = repeat_count.max(1);
    let mut audio_content = String::new();
    for _ in 0..repeat_count {
        for song in songs {
            let safe_path = escape_concat_path(&song.path);
            audio_content.push_str(&format!("file '{}'\n", safe_path));
        }
    }
    let total_audio_duration = single_loop_duration * repeat_count as f64;
    let force_hours = total_audio_duration >= 3600.0;
    let mut timestamps = Vec::new();
    let mut current_time = 0.0;
    if loop_count.is_some() || !youtube_timestamps {
        let mut play_num = 1;
        for _ in 0..repeat_count {
            for song in songs {
                let song_name = Path::new(&song.original_name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&song.original_name);
                let label = if repeat_count > 1 {
                    format!("{} (Play {})", song_name, play_num)
                } else {
                    song_name.to_string()
                };
                timestamps.push(format!("{} - {}", format_timestamp(current_time, force_hours), label));
                current_time += song.duration;
                play_num += 1;
            }
        }
    } else {
        for song in songs {
            let song_name = Path::new(&song.original_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&song.original_name);
            timestamps.push(format!("{} - {}", format_timestamp(current_time, force_hours), song_name));
            current_time += song.duration;
        }
        if current_time < total_audio_duration {
            timestamps.push(format!("{} - Looping", format_timestamp(current_time, force_hours)));
        }
    }
    if ping_pong_duration <= 0.0 {
        return Err(AppError::Pipeline("Ping-pong video duration zero".into()));
    }
    let mut video_content = String::new();
    let mut current_video_duration = 0.0;
    let ping_pong_path_str = escape_concat_path(&ping_pong_path.to_string_lossy());
    while current_video_duration < total_audio_duration + target.padding_sec as f64 {
        video_content.push_str(&format!("file '{}'\n", ping_pong_path_str));
        current_video_duration += ping_pong_duration;
    }
    Ok((audio_content, video_content, timestamps, total_audio_duration))
}
