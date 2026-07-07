use std::ffi::OsStr;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

use crate::error::AppError;

struct ChildGuard(Option<tauri_plugin_shell::process::CommandChild>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

pub async fn run<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: &[S],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    run_with_timeout(app, args, tx_progress, cancel_control, 86400).await
}

pub async fn run_with_timeout<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: &[S],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
    max_timeout_sec: u64,
) -> Result<(), AppError> {
    if let Some(ref control) = cancel_control {
        if control.is_paused() {
            control.wait_for_resume().await;
        }
        if control.is_cancelled() {
            return Err(cancelled_error());
        }
    }
    let sidecar_command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar_command.spawn().map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let mut _child_guard = ChildGuard(Some(child));
    
    let mut last_stderr = "Unknown ffmpeg error".to_string();
    let timeout_dur = std::time::Duration::from_secs(max_timeout_sec.max(300));
    let mut deadline = tokio::time::Instant::now() + timeout_dur;
    loop {
        if let Some(ref control) = cancel_control {
            if control.is_cancelled() {
                let _ = _child_guard.0.take().map(|c| c.kill());
                return Err(cancelled_error());
            }
            if control.is_paused() {
                let _ = _child_guard.0.take().map(|c| c.kill());
                let msg = "FFmpeg paused by user".into();
                return Err(AppError::Paused(msg));
            }
        }

        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                let _ = _child_guard.0.take().map(|c| c.kill());
                return Err(AppError::Ffmpeg(format!("FFmpeg process timed out ({}s limit)", max_timeout_sec)));
            }
            event_res = rx.recv() => {
                match event_res {
                    Some(CommandEvent::Stderr(line_bytes)) => {
                        // Use Cow<str> to avoid allocation for valid UTF-8 (typical case),
                        // only allocating for the rare invalid-UTF-8 scenario
                        let line_cow = String::from_utf8_lossy(&line_bytes);
                        if let (Some(tx), Some(time_sec)) = (&tx_progress, extract_time(&line_cow)) {
                            let _ = tx.send(time_sec).await;
                            deadline = tokio::time::Instant::now() + timeout_dur;
                        }
                        // Only capture non-progress lines as potential error messages
                        let trimmed = line_cow.trim();
                        if !trimmed.is_empty() && extract_time(trimmed).is_none() {
                            last_stderr = trimmed.to_string();
                        }
                    }
                    Some(CommandEvent::Stdout(_)) => {}
                    Some(CommandEvent::Error(err)) => {
                        last_stderr = err;
                    }
                    Some(CommandEvent::Terminated(payload)) => {
                        if payload.code != Some(0) {
                            return Err(AppError::Ffmpeg(last_stderr));
                        }
                        return Ok(());
                    }
                    Some(_) => {}
                    None => {
                        break;
                    }
                }
            }
            _ = async {
                if let Some(control) = &cancel_control {
                    tokio::select! {
                        _ = control.cancel_notify().notified() => {}
                        _ = control.pause_notify().notified() => {}
                    }
                } else {
                    std::future::pending().await
                }
            } => {}
        }
    }
    
    Ok(())
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
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let s: f64 = parts[2].parse().ok()?;
            return Some(h * 3600.0 + m * 60.0 + s);
        }
    }
    None
}

pub async fn get_duration(app: &AppHandle, file_path: &Path) -> Result<f64, AppError> {
    let sidecar_command = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &file_path.to_string_lossy(),
        ]);

    let output = sidecar_command.output().await.map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    let duration: f64 = trimmed.parse().map_err(|_| {
        AppError::Ffmpeg(format!("Gagal parse durasi dari ffprobe: '{}'", trimmed))
    })?;
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(
            file_path.to_string_lossy().to_string(),
        ));
    }
    Ok(duration)
}

pub async fn get_video_codec(app: &AppHandle, file_path: &Path) -> Result<String, AppError> {
    let sidecar_command = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args([
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

    let output = sidecar_command.output().await.map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let codec = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if codec.is_empty() {
        return Err(AppError::Ffmpeg(
            "Tidak dapat mendeteksi codec video".into(),
        ));
    }
    Ok(codec.to_lowercase())
}
