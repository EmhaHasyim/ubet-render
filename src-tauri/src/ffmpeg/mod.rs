use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use crate::error::AppError;

pub async fn run(
    args: &[String],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    if cancel_control
        .as_ref()
        .is_some_and(|control| control.is_cancelled())
    {
        return Err(cancelled_error());
    }
    let mut cmd = Command::new("ffmpeg");
    cmd.args(args);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let stderr = child.stderr.take().expect("Failed to capture stderr");
    let mut reader = BufReader::new(stderr).lines();
    let mut last_stderr = String::new();
    loop {
        tokio::select! {
            line_res = reader.next_line() => {
                match line_res {
                    Ok(Some(line)) => {
                        if let (Some(tx), Some(time_sec)) = (&tx_progress, extract_time(&line)) {
                            let _ = tx.send(time_sec).await;
                        }
                        if !line.trim().is_empty() {
                            last_stderr = line;
                        }
                    }
                    Ok(None) | Err(_) => {
                        break;
                    }
                }
            }
            _ = async {
                if let Some(control) = &cancel_control {
                    control.notify.notified().await
                } else {
                    std::future::pending().await
                }
            } => {
                let _ = child.kill().await;
                return Err(cancelled_error());
            }
        }
    }
    tokio::select! {
        status_res = child.wait() => {
            let status = status_res.map_err(|e| AppError::Ffmpeg(e.to_string()))?;
            if !status.success() {
                return Err(AppError::Ffmpeg(last_stderr));
            }
            Ok(())
        }
        _ = async {
            if let Some(control) = &cancel_control {
                control.notify.notified().await
            } else {
                std::future::pending().await
            }
        } => {
            let _ = child.kill().await;
            Err(cancelled_error())
        }
    }
}

fn cancelled_error() -> AppError {
    AppError::Cancelled("Render dibatalkan oleh pengguna".into())
}

fn extract_time(line: &str) -> Option<f64> {
    let time_marker = "time=";
    if let Some(start) = line.find(time_marker) {
        let after_time = &line[start + time_marker.len()..];
        let time_val = after_time.split_whitespace().next()?;
        let parts: Vec<&str> = time_val.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let s: f64 = parts[2].parse().unwrap_or(0.0);
            return Some(h * 3600.0 + m * 60.0 + s);
        }
    }
    None
}

pub async fn get_duration(file_path: &Path) -> Result<f64, AppError> {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        &file_path.to_string_lossy(),
    ]);
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let duration: f64 = stdout.trim().parse().unwrap_or(0.0);
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(
            file_path.to_string_lossy().to_string(),
        ));
    }
    Ok(duration)
}

pub async fn get_video_codec(file_path: &Path) -> Result<String, AppError> {
    let mut cmd = Command::new("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        &file_path.to_string_lossy(),
    ]);
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().await?;
    let codec = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if codec.is_empty() {
        return Err(AppError::Ffmpeg(
            "Tidak dapat mendeteksi codec video".into(),
        ));
    }
    Ok(codec.to_lowercase())
}
