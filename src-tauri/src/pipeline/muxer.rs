use crate::error::AppError;
use crate::ffmpeg;
use std::path::Path;

/// Build a same-container temporary output path. The final destination is
/// never handed to `FFmpeg` directly: a cancelled or failed encode must not
/// expose a truncated file or destroy a previously completed output.
fn render_temp_path(output: &Path) -> std::path::PathBuf {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    let stem = output.file_stem().map_or_else(
        || "output".into(),
        |value| value.to_string_lossy().into_owned(),
    );
    let extension = output.extension().map_or_else(
        || "mp4".into(),
        |value| value.to_string_lossy().into_owned(),
    );
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    parent.join(format!(
        ".{}.rendering-{}-{}.{}",
        stem,
        std::process::id(),
        nonce,
        extension
    ))
}

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
    // Convert paths to strings once for the concat demuxer. FFmpeg writes to
    // a unique same-container temporary file; only a successful process gets
    // to replace the final destination atomically.
    let video_list_str = video_list.to_string_lossy().into_owned();
    let audio_list_str = audio_list.to_string_lossy().into_owned();
    let total_duration_str = total_duration.to_string();
    let output_path = Path::new(output);
    let temp_output = render_temp_path(output_path);
    let temp_output_str = temp_output.to_string_lossy().into_owned();

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
        &temp_output_str,
    ];
    if let Err(error) = ffmpeg::run(app, &args, tx_progress, cancel_control.clone(), tx_stats).await
    {
        crate::utils::fs::cleanup_temp_file(&temp_output).await;
        return Err(error);
    }
    if let Err(error) = crate::utils::fs::atomic_replace_async(&temp_output, output_path).await {
        crate::utils::fs::cleanup_temp_file(&temp_output).await;
        return Err(AppError::Io(error));
    }

    if embed_chapters && !chapters.is_empty() {
        embed_chapters_into_output(
            app,
            output,
            output_path,
            cache_dir,
            chapters,
            cancel_control,
        )
        .await?;
    }

    Ok(())
}

/// Embed an ffmetadata chapter track into a same-container temp and swap it
/// over the output. Chapter insertion is best-effort; only the final atomic
/// replacement is fatal, because the original output remains usable.
async fn embed_chapters_into_output(
    app: &tauri::AppHandle,
    output: &str,
    output_path: &Path,
    cache_dir: &Path,
    chapters: &str,
    cancel_control: Option<std::sync::Arc<crate::RenderControl>>,
) -> Result<(), AppError> {
    // Only MP4 / M4V / MKV store chapters cleanly from an ffmetadata file.
    let extension = output_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    if !["mp4", "m4v", "mkv"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        return Ok(());
    }

    let chapter_path = cache_dir.join(format!(
        "chapters_{:x}.ffmeta",
        crate::utils::fs::hash_path(output.as_bytes())
    ));
    tokio::fs::write(&chapter_path, chapters)
        .await
        .map_err(AppError::Io)?;
    let chapter_path_str = chapter_path.to_string_lossy().into_owned();

    // Write chapters into a same-container temp, then swap it over the output.
    let tmp_out = render_temp_path(output_path);
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

    if let Err(e) = ffmpeg::run(app, &chapter_args, None, cancel_control, None).await {
        crate::utils::fs::cleanup_temp_file(&chapter_path).await;
        crate::utils::fs::cleanup_temp_file(&tmp_out).await;
        crate::utils::event::emit(
            app,
            crate::models::job::PipelineEvent::Log {
                level: "warn".into(),
                message: format!(
                    "Failed to embed chapters ({e}). Output file is usable without chapters."
                ),
            },
        );
        return Ok(());
    }

    if let Err(e) = crate::utils::fs::atomic_replace_async(&tmp_out, output_path).await {
        crate::utils::fs::cleanup_temp_file(&tmp_out).await;
        crate::utils::fs::cleanup_temp_file(&chapter_path).await;
        return Err(AppError::Io(e));
    }
    crate::utils::fs::cleanup_temp_file(&chapter_path).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::render_temp_path;
    use std::path::Path;

    #[test]
    fn render_temp_path_preserves_container_extension_and_destination_parent() {
        let output = Path::new("renders/final.mp4");
        let temporary = render_temp_path(output);

        assert_ne!(temporary, output);
        assert_eq!(temporary.parent(), output.parent());
        assert_eq!(
            temporary.extension().and_then(|ext| ext.to_str()),
            Some("mp4")
        );
        assert!(
            temporary
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".final.rendering-"))
        );
    }
}
