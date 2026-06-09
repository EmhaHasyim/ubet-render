use crate::config::{Target, VideoSettings};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::ProcessedAudio;
use std::path::Path;

pub struct PingPongVideoParams<'a> {
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
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), input.into()];
    let (final_map, filter_complex) = if let Some(wm) = watermark_path {
        args.extend(["-i".into(), wm.clone()]);
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
    let output_str = output.to_string_lossy().to_string();
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
        "-filter_complex".into(),
        filter_complex,
        "-map".into(),
        final_map.into(),
        "-c:v".into(),
        video_settings.encoder.clone(),
    ]);
    if video_settings.encoder.contains("nvenc") {
        args.extend([
            "-preset".into(),
            video_settings.preset.clone(),
            "-rc".into(),
            "vbr".into(),
            "-b:v".into(),
            video_settings.bitrate_target.clone(),
            "-maxrate".into(),
            video_settings.bitrate_max.clone(),
            "-bufsize".into(),
            bufsize,
        ]);
    } else if is_hw_encoder {
        args.extend([
            "-b:v".into(),
            video_settings.bitrate_target.clone(),
            "-maxrate".into(),
            video_settings.bitrate_max.clone(),
            "-bufsize".into(),
            bufsize,
        ]);
    } else {
        args.extend([
            "-crf".into(),
            "23".into(),
            "-maxrate".into(),
            video_settings.bitrate_max.clone(),
            "-bufsize".into(),
            bufsize,
        ]);
    }
    args.extend(["-r".into(), fps_str, output_str]);
    ffmpeg::run(&args, tx_progress, cancel_control).await
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
    youtube_timestamps: bool,
) -> Result<(String, String, Vec<String>, f64), AppError> {
    let single_loop_duration: f64 = songs.iter().map(|s| s.duration).sum();
    if single_loop_duration <= 0.0 {
        return Err(AppError::Pipeline("Audio loop duration is zero".into()));
    }
    fn escape_concat_path(path: &str) -> String {
        let mut result = String::with_capacity(path.len() + 10);
        for c in path.chars() {
            match c {
                '\'' => result.push_str("'\\''"),
                '\n' | '\r' => continue,
                '\\' => result.push('/'),
                _ => result.push(c),
            }
        }
        result
    }
    let mut audio_content = String::new();
    let mut total_audio_duration = 0.0;
    while total_audio_duration < target.min_duration_sec as f64 {
        for song in songs {
            let safe_path = escape_concat_path(&song.path);
            audio_content.push_str(&format!("file '{}'\n", safe_path));
        }
        total_audio_duration += single_loop_duration;
    }
    let force_hours = total_audio_duration >= 3600.0;
    let mut timestamps = Vec::new();
    let mut current_time = 0.0;
    if youtube_timestamps {
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
    } else {
        let mut loop_num = 1;
        while current_time < total_audio_duration {
            for song in songs {
                if current_time >= total_audio_duration {
                    break;
                }
                let song_name = Path::new(&song.original_name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&song.original_name);
                timestamps.push(format!(
                    "{} - {} (Loop {})",
                    format_timestamp(current_time, force_hours),
                    song_name,
                    loop_num
                ));
                current_time += song.duration;
            }
            loop_num += 1;
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
