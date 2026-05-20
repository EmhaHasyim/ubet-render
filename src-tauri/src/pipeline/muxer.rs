use crate::error::AppError;
use crate::ffmpeg;
use std::path::Path;

pub async fn mux_final_video(
    audio_list: &Path,
    video_list: &Path,
    output: &str,
    total_duration: f64,
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    let video_list_str = video_list.to_string_lossy().to_string();
    let audio_list_str = audio_list.to_string_lossy().to_string();
    let total_duration_str = total_duration.to_string();

    let args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        video_list_str,
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        audio_list_str,
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "copy".into(),
        "-t".into(),
        total_duration_str,
        output.into(),
    ];
    ffmpeg::run(&args, tx_progress, cancel_control).await
}
