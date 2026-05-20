use crate::config::AudioSettings;
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::media::ProcessedAudio;
use std::path::Path;
use std::sync::Arc;

pub async fn build_master_audio_pool(
    cache_dir: &Path,
    audio_files: &[String],
    settings: &AudioSettings,
    cancel_control: Option<Arc<crate::RenderControl>>,
) -> Result<Vec<ProcessedAudio>, AppError> {
    let mut pool = Vec::new();
    let concurrent = settings.concurrent_prep.max(1);
    let cache_dir = Arc::new(cache_dir.to_path_buf());
    let settings = Arc::new(settings.clone());
    let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrent));

    let mut tasks = Vec::new();

    for (idx, song) in audio_files.iter().enumerate() {
        let song = song.clone();
        let cache_dir = Arc::clone(&cache_dir);
        let settings = Arc::clone(&settings);
        let cancel_control = cancel_control.clone();
        let sem = Arc::clone(&semaphore);

        tasks.push(tokio::spawn(async move {
            if cancel_control
                .as_ref()
                .is_some_and(|control| control.is_cancelled())
            {
                return Err(AppError::Cancelled(
                    "Render dibatalkan oleh pengguna".into(),
                ));
            }

            let _permit = sem
                .acquire()
                .await
                .map_err(|e| AppError::Pipeline(format!("Audio worker unavailable: {}", e)))?;
            let original_path = Path::new(&song);
            let cache_path = cache_dir.join(format!("master_audio_{}.m4a", idx));

            if !cache_path.exists() {
                let loudnorm = &settings.loudnorm_params;
                let bitrate = &settings.bitrate;
                let sample_rate = settings.sample_rate.to_string();

                let args: Vec<String> = vec![
                    "-y".into(),
                    "-i".into(),
                    original_path.to_string_lossy().to_string(),
                    "-vn".into(),
                    "-af".into(),
                    format!("loudnorm={}", loudnorm),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    bitrate.clone(),
                    "-ar".into(),
                    sample_rate,
                    "-ac".into(),
                    "2".into(),
                    cache_path.to_string_lossy().to_string(),
                ];
                ffmpeg::run(&args, None, cancel_control.clone()).await?;
            }

            let duration = ffmpeg::get_duration(&cache_path).await?;
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
        }));
    }

    for task in tasks {
        match task.await {
            Ok(Ok(audio)) => pool.push(audio),
            Ok(Err(AppError::Cancelled(e))) => return Err(AppError::Cancelled(e)),
            Ok(Err(e)) => {
                eprintln!("Audio processing error: {}", e);
            }
            Err(join_err) => {
                eprintln!("Audio task panicked: {}", join_err);
            }
        }
    }
    Ok(pool)
}
