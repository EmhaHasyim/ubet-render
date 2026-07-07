use crate::error::AppError;
use crate::ffmpeg;
use std::path::Path;

pub async fn mux_final_video(
    app: &tauri::AppHandle,
    audio_list: &Path,
    video_list: &Path,
    output: &str,
    total_duration: f64,
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    // Convert paths to strings once for the concat demuxer
    let video_list_str = video_list.to_string_lossy().into_owned();
    let audio_list_str = audio_list.to_string_lossy().into_owned();
    let total_duration_str = total_duration.to_string();

    // Use &[&str] slice — static strings are borrowed, no .into() allocation needed
    let args: Vec<&str> = vec![
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        &video_list_str,
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        &audio_list_str,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-t",
        &total_duration_str,
        output,
    ];
    ffmpeg::run(app, &args, tx_progress, cancel_control).await
}
