use crate::error::AppError;
use crate::ffmpeg;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
pub async fn mux_final_video(
    app: &tauri::AppHandle,
    audio_list: &Path,
    video_list: &Path,
    output: &str,
    total_duration: f64,
    cache_dir: &Path,
    embed_chapters: bool,
    chapters: &str,
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
    tx_stats: Option<tokio::sync::mpsc::Sender<crate::models::job::RenderStats>>,
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
    ffmpeg::run(app, &args, tx_progress, cancel_control.clone(), tx_stats).await?;

    if embed_chapters && !chapters.is_empty() {
        // Only MP4 / M4V / MKV store chapters cleanly from an ffmetadata file.
        let lower = output.to_ascii_lowercase();
        let supports = lower.ends_with(".mp4")
            || lower.ends_with(".m4v")
            || lower.ends_with(".mkv");
        if supports {
            let chapter_path = cache_dir.join(format!(
                "chapters_{:x}.ffmeta",
                crate::utils::fs::hash_path(output.as_bytes())
            ));
            tokio::fs::write(&chapter_path, chapters)
                .await
                .map_err(AppError::Io)?;
            let chapter_path_str = chapter_path.to_string_lossy().into_owned();

            // Write chapters into a same-container temp, then swap it over the output.
            let out_path = std::path::Path::new(output);
            let tmp_out = if let Some(parent) = out_path.parent() {
                let stem = out_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "output".into());
                let ext = out_path
                    .extension()
                    .map(|e| e.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "mp4".into());
                parent.join(format!("{}.chaptered.{}", stem, ext))
            } else {
                std::path::PathBuf::from(format!("{}.chaptered.mp4", output))
            };
            let tmp_out_str = tmp_out.to_string_lossy().into_owned();

            let chapter_args: Vec<&str> = vec![
                "-y",
                "-i",
                output,
                "-i",
                &chapter_path_str,
                "-map_metadata",
                "1",
                "-map",
                "0",
                "-c",
                "copy",
                &tmp_out_str,
            ];
            if let Err(e) = ffmpeg::run(app, &chapter_args, None, cancel_control.clone(), None).await {
                // Chapter insertion is best-effort: the output file is already usable
                // without chapters, so a warning is sufficient.
                let _ = crate::utils::fs::safe_delete(&chapter_path).await;
                let _ = crate::utils::fs::safe_delete(&tmp_out).await;
                crate::utils::event::emit(app, crate::models::job::PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!(
                        "Failed to embed chapters ({}). Output file is usable without chapters.",
                        e
                    ),
                });
            } else {
                if let Err(e) = tokio::fs::rename(&tmp_out, output).await {
                    let _ = crate::utils::fs::safe_delete(&tmp_out).await;
                    let _ = crate::utils::fs::safe_delete(&chapter_path).await;
                    return Err(AppError::Io(e));
                }
                crate::utils::fs::safe_delete(&chapter_path).await.ok();
            }
        }
    }

    Ok(())
}
