// src-tauri/src/pipeline/video_loop.rs
use crate::config::{Target, VideoSettings};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::ProcessedAudio;
use std::path::Path;

pub async fn create_ping_pong_video(
    input: &str,
    output: &Path,
    video_settings: &VideoSettings,
    use_pingpong: bool,
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    let filter = if use_pingpong {
        "[0:v]scale=1920:1080:flags=lanczos,unsharp=3:3:1.0:3:3:0.0[upscaled];[upscaled]split[s1][s2];[s2]reverse[r];[s1][r]concat=n=2:v=1[v]".to_string()
    } else {
        "[0:v]scale=1920:1080:flags=lanczos,unsharp=3:3:1.0:3:3:0.0[v]".to_string()
    };
    let fps_str = video_settings.fps.to_string();
    let output_str = output.to_string_lossy().to_string();

    // Hitung bufsize dari bitrate_max (2x maxrate)
    let maxrate_k = video_settings
        .bitrate_max
        .trim_end_matches('k')
        .parse::<u32>()
        .unwrap_or(5000);
    let bufsize_k = maxrate_k * 2;
    let bufsize = format!("{}k", bufsize_k);

    let is_hw_encoder = video_settings.encoder.contains("nvenc")
        || video_settings.encoder.contains("amf")
        || video_settings.encoder.contains("qsv");

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input.into(),
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "[v]".into(),
        "-c:v".into(),
        video_settings.encoder.clone(),
    ];

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
    target: &Target,
) -> Result<(String, String, Vec<String>, f64), AppError> {
    let single_loop_duration: f64 = songs.iter().map(|s| s.duration).sum();
    if single_loop_duration <= 0.0 {
        return Err(AppError::Pipeline("Audio loop duration is zero".into()));
    }

    let mut audio_content = String::new();
    let mut total_audio_duration = 0.0;
    while total_audio_duration < target.min_duration_sec as f64 {
        for song in songs {
            let safe_path = song.path.replace('\'', "'\\''").replace('\\', "/");
            audio_content.push_str(&format!("file '{}'\n", safe_path));
        }
        total_audio_duration += single_loop_duration;
    }

    let force_hours = total_audio_duration >= 3600.0;
    let mut timestamps = Vec::new();
    let mut current_time = 0.0;
    for song in songs {
        timestamps.push(format!("{} - {}", format_timestamp(current_time, force_hours), song.original_name));
        current_time += song.duration;
    }

    if current_time < total_audio_duration {
        timestamps.push(format!("{} - Looping", format_timestamp(current_time, force_hours)));
    }

    let ping_pong_duration = ffmpeg::get_duration(ping_pong_path).await?;
    if ping_pong_duration <= 0.0 {
        return Err(AppError::Pipeline("Ping-pong video duration zero".into()));
    }

    let mut video_content = String::new();
    let mut current_video_duration = 0.0;
    let ping_pong_path_str = ping_pong_path
        .to_string_lossy()
        .replace('\'', "'\\''")
        .replace('\\', "/");
    while current_video_duration < total_audio_duration + target.padding_sec as f64 {
        video_content.push_str(&format!("file '{}'\n", ping_pong_path_str));
        current_video_duration += ping_pong_duration;
    }

    Ok((audio_content, video_content, timestamps, total_audio_duration))
}
