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
    audio_mode: &str,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<Arc<Vec<ProcessedAudio>>, AppError> {
    let mut pool = Vec::new();
    // Auto-scale concurrency: respect the user's config as an upper bound but
    // never exceed `available_parallelism × 2` so that I/O-bound audio encoding
    // doesn't overwhelm the CPU. This gives high-core-count systems better
    // throughput while keeping low-core systems from over-saturating.
    let max_parallel = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let concurrent = settings.concurrent_prep.max(1).min(max_parallel.saturating_mul(2));
    let cache_dir = Arc::new(cache_dir.to_path_buf());
    // Extract fields early so the async move closure doesn't capture the whole AudioSettings
    let loudnorm_params = settings.loudnorm_params.clone();
    let bitrate = settings.bitrate.clone();
    let sample_rate = settings.sample_rate;
    // `original` keeps the source audio faithful (no loudness change); only
    // `normalize` applies the YouTube Music loudnorm preset.
    let normalize = audio_mode.eq_ignore_ascii_case("normalize");
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
                    "Render cancelled by user".into(),
                ));
            }
            let original_path = Path::new(&song);
            // Include the processing parameters in the cache key. Without this,
            // changing bitrate / sample rate / loudnorm silently reuses a stale
            // cached file and the new settings are ignored (bug A).
            let cache_key = format!("{}|{}|{}|{}", song, br, sample_rate, lp);
            let file_hash = crate::utils::fs::hash_path128(cache_key.as_bytes());
            let cache_path = cache_dir.join(format!("master_audio_{:032x}.m4a", file_hash));
            if !cache_path.exists() {
                let sample_rate_str = sample_rate.to_string();
                let input_path_str = original_path.to_string_lossy().into_owned();
                let output_path_str = cache_path.to_string_lossy().into_owned();
                // Use &[&str] — static strings are borrowed, no .into() allocation needed
                let mut args: Vec<&str> = vec![
                    "-y",
                    "-i",
                    &input_path_str,
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    &br,
                    "-ar",
                    &sample_rate_str,
                    "-ac",
                    "2",
                ];
                // `original` mode skips normalization; `normalize` applies the
                // YouTube Music loudnorm preset.
                let loudnorm_arg = if normalize {
                    Some(format!("loudnorm={}", lp))
                } else {
                    None
                };
                if let Some(la) = &loudnorm_arg {
                    args.push("-af");
                    args.push(la);
                }
                args.push(&output_path_str);
                ffmpeg::run(&app_clone, &args, None, cancel_control.clone(), None).await?;
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
    let mut failed_count = 0usize;
    while let Some(res) = stream.next().await {
        match res {
            Ok(audio) => pool.push(audio),
            Err(AppError::Cancelled(e)) => return Err(AppError::Cancelled(e)),
            Err(e) => {
                failed_count += 1;
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
    if failed_count > 0 {
        event::emit(
            app,
            crate::models::job::PipelineEvent::Log {
                level: "warn".into(),
                message: format!(
                    "{} audio tracks failed to process; the playlist may be smaller than configured",
                    failed_count
                ),
            },
        );
    }
    Ok(Arc::new(pool))
}
