pub mod audio_pool;
pub mod muxer;
pub mod video_loop;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::job::{JobState, PipelineEvent, RenderJob};
use crate::models::media::{ProcessedAudio, VideoFile};
use crate::models::settings::{MediaSource, OverrideConfig};
use crate::utils::event;
use crate::utils::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

pub struct Pipeline {
    config: AppConfig,
    app: AppHandle,
}

impl Pipeline {
    pub fn new(app: AppHandle, config: AppConfig) -> Self {
        Self { app, config }
    }

    pub async fn execute(
        self,
        overrides: Option<OverrideConfig>,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        let output_dir = fs::to_absolute(&self.resolve_output_dir(&overrides));
        let cache_dir = std::env::temp_dir().join("ubet-render").join("cache");
        let thumb_dir = std::env::temp_dir().join("ubet-render").join("thumbnails");

        let _ = tokio::fs::remove_dir_all(&thumb_dir).await;
        let _ = tokio::fs::remove_dir_all(&cache_dir).await;

        fs::ensure_dir(&output_dir).await?;
        fs::ensure_dir(&cache_dir).await?;
        fs::ensure_dir(&thumb_dir).await?;

        let render_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        if control.is_cancelled() {
            return Err(AppError::Cancelled(
                "Render dibatalkan oleh pengguna".into(),
            ));
        }

        let video_files = self
            .scan_source_files(&overrides, Path::new(&self.config.directories.video), "video")
            .await?;
        let audio_files = self
            .scan_source_files(&overrides, Path::new(&self.config.directories.audio), "audio")
            .await?;

        if video_files.is_empty() {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "error".into(),
                    message: "Tidak ada file video yang dipilih atau ditemukan".into(),
                },
            );
            return Err(AppError::NoVideo);
        }
        if audio_files.is_empty() {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "error".into(),
                    message: "Tidak ada file audio yang dipilih atau ditemukan".into(),
                },
            );
            return Err(AppError::NoAudio);
        }

        let use_pingpong = overrides
            .as_ref()
            .and_then(|ov| ov.use_pingpong)
            .unwrap_or(true);

        let youtube_timestamps = overrides
            .as_ref()
            .and_then(|ov| ov.youtube_timestamps)
            .unwrap_or(self.config.youtube_timestamps);

        let songs_per_playlist = overrides
            .as_ref()
            .and_then(|ov| ov.songs_per_playlist)
            .unwrap_or(self.config.audio.songs_per_playlist)
            .max(1);

        let min_duration_sec = overrides
            .as_ref()
            .and_then(|ov| ov.min_duration_hours)
            .map(|h| (h * 3600.0) as u64)
            .unwrap_or(self.config.target.min_duration_sec);
        
        let encoder_selected = overrides.as_ref().and_then(|ov| ov.encoder.clone());
        let prefix = overrides
            .as_ref()
            .and_then(|ov| ov.output_prefix.as_deref())
            .unwrap_or(&self.config.metadata.channel_prefix);
        let safe_prefix = sanitize_filename_component(prefix);

        let maxrate_str = overrides
            .as_ref()
            .and_then(|ov| ov.maxrate.clone())
            .unwrap_or_else(|| self.config.video.bitrate_target.clone());

        let maxrate_k = parse_bitrate_k(&maxrate_str).unwrap_or(4000).max(1);
        let target_k = (maxrate_k as f64 * 0.7).ceil() as u32;

        let mut video_cfg = self.config.video.clone();
        video_cfg.bitrate_target = format!("{}k", target_k);
        video_cfg.bitrate_max = format!("{}k", maxrate_k);

        if let Some(enc) = encoder_selected.as_deref() {
            video_cfg.encoder = enc.to_string();
        }

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: "Membangun Master Audio Pool...".into(),
            },
        );

        let master_pool = audio_pool::build_master_audio_pool(
            &cache_dir,
            &audio_files,
            &self.config.audio,
            Some(control.clone()),
        )
        .await?;

        if master_pool.is_empty() {
            return Err(AppError::NoAudio);
        }

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!("{} lagu siap digunakan.", master_pool.len()),
            },
        );

        let mut jobs = self.create_initial_jobs(&video_files, &safe_prefix, &output_dir);

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: "Generating thumbnails...".into(),
            },
        );

        self.generate_thumbnails(&mut jobs, &thumb_dir, render_timestamp, control.clone()).await;

        if control.is_cancelled() {
            return Err(AppError::Cancelled(
                "Render dibatalkan oleh pengguna".into(),
            ));
        }

        self.emit_progress(&jobs, &jobs[0]);

        let total = jobs.len();
        let mut completed = 0;

        for i in 0..jobs.len() {
            if control.is_cancelled() {
                return Err(AppError::Cancelled(
                    "Render dibatalkan oleh pengguna".into(),
                ));
            }

            if Path::new(&jobs[i].video.output_path).exists() {
                jobs[i].state = JobState::Done;
                jobs[i].progress_percent = 100;
                jobs[i].current_step = "Skipped".into();
                completed += 1;
                event::emit(
                    &self.app,
                    PipelineEvent::Log {
                        level: "info".into(),
                        message: format!("Melewati {} (sudah ada)", jobs[i].video.name),
                    },
                );
                self.emit_progress(&jobs, &jobs[i]);
                continue;
            }

            let result = self.process_single_job(
                i,
                &mut jobs,
                &cache_dir,
                render_timestamp,
                use_pingpong,
                &video_cfg,
                encoder_selected.as_deref(),
                &master_pool,
                songs_per_playlist,
                min_duration_sec,
                youtube_timestamps,
                control.clone(),
            )
            .await;

            match result {
                Ok(()) => {
                    completed += 1;
                    event::emit(
                        &self.app,
                        PipelineEvent::Log {
                            level: "success".into(),
                            message: format!("{} selesai", jobs[i].video.name),
                        },
                    );
                }
                Err(AppError::Cancelled(msg)) => {
                    return Err(AppError::Cancelled(msg));
                }
                Err(e) => {
                    jobs[i].state = JobState::Error;
                    jobs[i].error = Some(e.to_string());
                    self.emit_progress(&jobs, &jobs[i]);
                }
            }
        }

        let _ = tokio::fs::remove_dir_all(&cache_dir).await;

        let failed = jobs.iter().filter(|j| j.state == JobState::Error).count();
        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!(
                    "Render selesai: {}/{} sukses, {} gagal",
                    completed, total, failed
                ),
            },
        );
        event::emit(
            &self.app,
            PipelineEvent::Done {
                completed,
                total,
                failed,
            },
        );
        Ok(())
    }

    fn create_initial_jobs(
        &self,
        video_files: &[String],
        safe_prefix: &str,
        output_dir: &Path,
    ) -> Vec<RenderJob> {
        let mut jobs = Vec::new();
        for path_str in video_files {
            let input_path = Path::new(path_str);
            let name = input_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let output_name = if safe_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}_{}", safe_prefix, name)
            };
            jobs.push(RenderJob {
                video: VideoFile {
                    name: name.clone(),
                    input_path: path_str.clone(),
                    output_path: output_dir.join(&output_name).to_string_lossy().to_string(),
                    thumbnail_path: None,
                },
                state: JobState::Pending,
                progress_percent: 0,
                current_step: "Pending".into(),
                error: None,
            });
        }
        jobs
    }

    async fn generate_thumbnails(
        &self,
        jobs: &mut [RenderJob],
        thumb_dir: &Path,
        render_timestamp: u64,
        control: Arc<crate::RenderControl>,
    ) {
        let mut thumb_tasks = Vec::new();
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        for (i, job) in jobs.iter().enumerate() {
            let input_path = job.video.input_path.clone();
            let thumb_path = thumb_dir.join(format!("thumb_{}_{}.jpg", render_timestamp, i));

            if !thumb_path.exists() {
                let args = vec![
                    "-y".into(),
                    "-ss".into(),
                    "00:00:01".into(),
                    "-i".into(),
                    input_path,
                    "-vframes".into(),
                    "1".into(),
                    "-vf".into(),
                    "scale=320:-1".into(),
                    thumb_path.to_string_lossy().to_string(),
                ];
                let control_clone = control.clone();
                let sem = semaphore.clone();
                thumb_tasks.push(tokio::spawn(async move {
                    let Ok(_permit) = sem.acquire().await else {
                        return;
                    };
                    let _ = ffmpeg::run(&args, None, Some(control_clone)).await;
                }));
            }
        }

        self.emit_progress(jobs, &jobs[0].clone());

        for t in thumb_tasks {
            let _ = t.await;
        }

        for (i, job) in jobs.iter_mut().enumerate() {
            let thumb_path = thumb_dir.join(format!("thumb_{}_{}.jpg", render_timestamp, i));
            if thumb_path.exists() {
                job.video.thumbnail_path = Some(thumb_path.to_string_lossy().to_string());
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn process_single_job(
        &self,
        i: usize,
        jobs: &mut [RenderJob],
        cache_dir: &Path,
        render_timestamp: u64,
        use_pingpong: bool,
        video_cfg: &crate::config::VideoSettings,
        encoder_selected: Option<&str>,
        master_pool: &[ProcessedAudio],
        songs_per_playlist: usize,
        min_duration_sec: u64,
        youtube_timestamps: bool,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        jobs[i].state = JobState::Processing;
        jobs[i].current_step = "Preparing".into();
        self.emit_progress(jobs, &jobs[i].clone());

        let timestamp = format!("{}_{}", render_timestamp, i);

        let input_codec = ffmpeg::get_video_codec(Path::new(&jobs[i].video.input_path))
            .await
            .ok();

        let need_reencode = match (&input_codec, encoder_selected) {
            (Some(in_codec), Some(enc)) => {
                let mapped_enc = match enc {
                    "libx264" | "h264_nvenc" | "h264_amf" | "h264_qsv" => "h264",
                    "libx265" | "hevc_nvenc" | "hevc_amf" | "hevc_qsv" => "hevc",
                    "av1_nvenc" | "av1_amf" | "av1_qsv" | "libsvtav1" => "av1",
                    _ => enc,
                };
                in_codec != mapped_enc
            }
            _ => true,
        };

        let ping_pong_path;
        let created_intermediate;

        if use_pingpong {
            jobs[i].current_step = "1/2 Upscaling & Ping-Pong".into();
            self.emit_progress(jobs, &jobs[i].clone());

            ping_pong_path = cache_dir.join(format!("pingpong_{}.mp4", timestamp));
            created_intermediate = true;

            let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
            let ping_pong_path_clone = ping_pong_path.clone();
            let input_clone = jobs[i].video.input_path.clone();
            let video_cfg_clone = video_cfg.clone();

            let expected_dur = ffmpeg::get_duration(Path::new(&input_clone))
                .await
                .unwrap_or(1.0)
                .max(0.001);
            let target_dur = expected_dur * 2.0;
            let control_clone = control.clone();

            let ffmpeg_task = tokio::spawn(async move {
                video_loop::create_ping_pong_video(
                    &input_clone,
                    &ping_pong_path_clone,
                    &video_cfg_clone,
                    true,
                    Some(tx),
                    Some(control_clone),
                )
                .await
            });

            while let Some(progress_sec) = rx.recv().await {
                let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
                jobs[i].progress_percent = pct / 2;
                self.emit_progress(jobs, &jobs[i].clone());
            }

            match ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e)))) {
                Ok(()) => {}
                Err(e) => {
                    let _ = fs::safe_delete(&ping_pong_path).await;
                    return Err(e);
                }
            }
        } else if need_reencode {
            jobs[i].current_step = "1/2 Re-encode video".into();
            self.emit_progress(jobs, &jobs[i].clone());

            ping_pong_path = cache_dir.join(format!("looping_{}.mp4", timestamp));
            created_intermediate = true;

            let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
            let ping_pong_path_clone = ping_pong_path.clone();
            let input_clone = jobs[i].video.input_path.clone();
            let video_cfg_clone = video_cfg.clone();

            let target_dur = ffmpeg::get_duration(Path::new(&input_clone))
                .await
                .unwrap_or(1.0)
                .max(0.001);
            let control_clone = control.clone();

            let ffmpeg_task = tokio::spawn(async move {
                video_loop::create_ping_pong_video(
                    &input_clone,
                    &ping_pong_path_clone,
                    &video_cfg_clone,
                    false,
                    Some(tx),
                    Some(control_clone),
                )
                .await
            });

            while let Some(progress_sec) = rx.recv().await {
                let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
                jobs[i].progress_percent = pct / 2;
                self.emit_progress(jobs, &jobs[i].clone());
            }

            match ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e)))) {
                Ok(()) => {}
                Err(e) => {
                    let _ = fs::safe_delete(&ping_pong_path).await;
                    return Err(e);
                }
            }
        } else {
            jobs[i].current_step = "1/2 Menggunakan video asli".into();
            self.emit_progress(jobs, &jobs[i].clone());
            ping_pong_path = PathBuf::from(&jobs[i].video.input_path);
            created_intermediate = false;
        }

        jobs[i].current_step = "2/2 Smart Loop & Muxing".into();
        jobs[i].progress_percent = 50;
        self.emit_progress(jobs, &jobs[i].clone());

        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::from_entropy();
        let mut shuffled = master_pool.to_vec();
        use rand::seq::SliceRandom;
        shuffled.shuffle(&mut rng);
        let take_count = songs_per_playlist.min(shuffled.len()).max(1);
        let selected_songs: Vec<ProcessedAudio> = shuffled.into_iter().take(take_count).collect();

        let target_override = crate::config::Target {
            min_duration_sec,
            padding_sec: self.config.target.padding_sec,
        };
        let (audio_content, video_content, timestamps, total_duration) =
            video_loop::generate_loop_playlists(
                &selected_songs,
                &ping_pong_path,
                &target_override,
                youtube_timestamps,
            )
            .await?;

        let mut ts_path = PathBuf::from(&jobs[i].video.output_path);
        ts_path.set_extension("txt");
        tokio::fs::write(&ts_path, timestamps.join("\n")).await?;

        event::emit(
            &self.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!("=== Timestamps untuk {} ===", jobs[i].video.name),
            },
        );
        for ts in &timestamps {
            event::emit(
                &self.app,
                PipelineEvent::Log {
                    level: "info".into(),
                    message: ts.clone(),
                },
            );
        }

        let audio_list_path = cache_dir.join(format!("audio_list_{}.txt", timestamp));
        let video_list_path = cache_dir.join(format!("video_list_{}.txt", timestamp));
        tokio::fs::write(&audio_list_path, &audio_content).await?;
        tokio::fs::write(&video_list_path, &video_content).await?;

        jobs[i].progress_percent = 50;
        self.emit_progress(jobs, &jobs[i].clone());

        let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
        let audio_list_path_clone = audio_list_path.clone();
        let video_list_path_clone = video_list_path.clone();
        let output_path_clone = jobs[i].video.output_path.clone();
        let total_dur = total_duration;
        let control_clone = control.clone();

        let ffmpeg_task = tokio::spawn(async move {
            muxer::mux_final_video(
                &audio_list_path_clone,
                &video_list_path_clone,
                &output_path_clone,
                total_dur,
                Some(tx),
                Some(control_clone),
            )
            .await
        });

        while let Some(progress_sec) = rx.recv().await {
            let pct = (progress_sec / total_dur * 100.0).clamp(0.0, 100.0) as u8;
            jobs[i].progress_percent = 50 + (pct / 2);
            self.emit_progress(jobs, &jobs[i].clone());
        }

        let res = ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))));

        if created_intermediate {
            let _ = fs::safe_delete(&ping_pong_path).await;
        }
        let _ = fs::safe_delete(&audio_list_path).await;
        let _ = fs::safe_delete(&video_list_path).await;

        match res {
            Ok(()) => {
                jobs[i].state = JobState::Done;
                jobs[i].progress_percent = 100;
                self.emit_progress(jobs, &jobs[i].clone());
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    fn emit_progress(&self, jobs: &[RenderJob], current: &RenderJob) {
        let total = jobs.len();
        let completed = jobs.iter().filter(|j| j.state == JobState::Done).count();
        event::emit(
            &self.app,
            PipelineEvent::Progress {
                total,
                completed,
                current_video: current.video.name.clone(),
                jobs: jobs.to_vec(),
            },
        );
    }

    fn resolve_output_dir(&self, overrides: &Option<OverrideConfig>) -> PathBuf {
        if let Some(path) = overrides.as_ref().and_then(|ov| ov.output_path.as_ref()) {
            return PathBuf::from(path);
        }
        PathBuf::from(&self.config.directories.output)
    }

    async fn scan_source_files(
        &self,
        overrides: &Option<OverrideConfig>,
        default_dir: &Path,
        media_type: &str,
    ) -> Result<Vec<String>, AppError> {
        let extensions: &[&str] = match media_type {
            "video" => &[".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".wmv"],
            "audio" => &[".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma"],
            _ => &[],
        };

        let source = match (media_type, overrides.as_ref()) {
            ("video", Some(ov)) => ov.video_source.as_ref(),
            ("audio", Some(ov)) => ov.audio_source.as_ref(),
            _ => None,
        };

        let mut files = match source {
            Some(MediaSource::Folder { path }) => {
                let abs_path = fs::to_absolute(Path::new(path));
                fs::scan_files(&abs_path, extensions).await
            }
            Some(MediaSource::Files { paths }) => {
                let mut all_files = Vec::new();
                for p_str in paths {
                    let p = Path::new(p_str);
                    if p.is_dir() {
                        let scanned = fs::scan_files(p, extensions).await;
                        all_files.extend(scanned);
                    } else if p.is_file() {
                        let lower = p_str.to_lowercase();
                        if extensions.iter().any(|ext| lower.ends_with(ext)) {
                            all_files.push(p_str.clone());
                        }
                    }
                }
                all_files
            }
            None => {
                let default_abs = fs::to_absolute(Path::new(default_dir));
                fs::scan_files(&default_abs, extensions).await
            }
        };

        files.sort();
        files.dedup();
        Ok(files)
    }
}

fn parse_bitrate_k(value: &str) -> Option<u32> {
    let normalized = value.trim().to_ascii_lowercase();
    let number = normalized.strip_suffix('k').unwrap_or(&normalized);
    number.parse::<u32>().ok()
}

fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();

    sanitized.trim().trim_matches('.').to_string()
}
