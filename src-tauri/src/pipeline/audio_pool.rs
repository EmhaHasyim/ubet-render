use crate::config::AudioSettings;
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::ProcessedAudio;
use crate::utils::event;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use futures::stream::{self, StreamExt};

pub async fn build_master_audio_pool(
    app: &AppHandle,
    cache_dir: &Path,
    audio_files: &[String],
    settings: &AudioSettings,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<Vec<ProcessedAudio>, AppError> {
    let mut pool = Vec::new();
    let concurrent = settings.concurrent_prep.max(1);
    let cache_dir = Arc::new(cache_dir.to_path_buf());
    // Extract fields early so the async move closure doesn't capture the whole AudioSettings
    let loudnorm_params = settings.loudnorm_params.clone();
    let bitrate = settings.bitrate.clone();
    let sample_rate = settings.sample_rate;
    let mut stream = stream::iter(audio_files.iter().cloned().map(move |song| {
        let cache_dir = Arc::clone(&cache_dir);
        let cancel_control = cancel_control.clone();
        let app_clone = app.clone();
        // Clone strings for each invocation since FnMut may be called multiple times
        let lp = loudnorm_params.clone();
        let br = bitrate.clone();
        async move {
            if cancel_control
                .as_ref()
                .is_some_and(|control| control.is_cancelled())
            {
                return Err(AppError::Cancelled(
                    "Render dibatalkan oleh pengguna".into(),
                ));
            }
            let original_path = Path::new(&song);
            let file_hash = crate::utils::fs::hash_path(song.as_bytes());
            let cache_path = cache_dir.join(format!("master_audio_{:x}.m4a", file_hash));
            if !cache_path.exists() {
                let sample_rate_str = sample_rate.to_string();
                let input_path_str = original_path.to_string_lossy().into_owned();
                let output_path_str = cache_path.to_string_lossy().into_owned();
                let loudnorm_arg = format!("loudnorm={}", lp);
                // Use &[&str] — static strings are borrowed, no .into() allocation needed
                let args: Vec<&str> = vec![
                    "-y",
                    "-i",
                    &input_path_str,
                    "-vn",
                    "-af",
                    &loudnorm_arg,
                    "-c:a",
                    "aac",
                    "-b:a",
                    &br,
                    "-ar",
                    &sample_rate_str,
                    "-ac",
                    "2",
                    &output_path_str,
                ];
                ffmpeg::run(&app_clone, &args, None, cancel_control.clone()).await?;
            }
            let duration = ffmpeg::get_duration(&app_clone, &cache_path).await?;
            if duration <= 0.0 {
                return Err(AppError::InvalidDuration(song));
            }
            Ok(ProcessedAudio {
                path: cache_path.to_string_lossy().to_string(),
                duration,
                original_name: original_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            })
        }
    }))
    .buffer_unordered(concurrent);
    while let Some(res) = stream.next().await {
        match res {
            Ok(audio) => pool.push(audio),
            Err(AppError::Cancelled(e)) => return Err(AppError::Cancelled(e)),
            Err(e) => {
                event::emit(
                    app,
                    crate::models::job::PipelineEvent::Log {
                        level: "error".into(),
                        message: format!("Audio processing error: {}", e),
                    },
                );
            }
        }
    }
    Ok(pool)
}
