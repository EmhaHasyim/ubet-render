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
use futures::StreamExt;
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
        resume: bool,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        let output_dir = fs::to_absolute(&self.resolve_output_dir(&overrides));
        let cache_dir = std::env::temp_dir().join("ubet-render").join("cache");
        let thumb_dir = std::env::temp_dir().join("ubet-render").join("thumbnails");
        let state_path = output_dir.join("ubet_render_state.json");

        if !resume {
            let _ = tokio::fs::remove_dir_all(&thumb_dir).await;
            let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        }

        fs::ensure_dir(&output_dir).await?;
        fs::ensure_dir(&cache_dir).await?;
        fs::ensure_dir(&thumb_dir).await?;

        let render_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        if control.is_cancelled() || control.is_paused() {
            return Err(AppError::Cancelled("Render dibatalkan/dipause oleh pengguna".into()));
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

        let use_pingpong = overrides.as_ref().and_then(|ov| ov.use_pingpong).unwrap_or(true);
        let youtube_timestamps = overrides.as_ref().and_then(|ov| ov.youtube_timestamps).unwrap_or(self.config.youtube_timestamps);
        let max_concurrent_jobs = overrides.as_ref().and_then(|ov| ov.max_concurrent_jobs).unwrap_or(self.config.max_concurrent_jobs).max(1);
        let watermark_path = overrides.as_ref().and_then(|ov| ov.watermark_path.clone()).or(self.config.watermark_path.clone());
        let watermark_opacity = overrides.as_ref().and_then(|ov| ov.watermark_opacity).unwrap_or(self.config.watermark_opacity);
        
        let songs_per_playlist = overrides.as_ref().and_then(|ov| ov.songs_per_playlist).unwrap_or(self.config.audio.songs_per_playlist).max(1);
        let min_duration_sec = overrides.as_ref().and_then(|ov| ov.min_duration_hours).map(|h| (h * 3600.0) as u64).unwrap_or(self.config.target.min_duration_sec);
        
        let encoder_selected = overrides.as_ref().and_then(|ov| ov.encoder.clone());
        let prefix = overrides.as_ref().and_then(|ov| ov.output_prefix.as_deref()).unwrap_or(&self.config.metadata.channel_prefix);
        let safe_prefix = sanitize_filename_component(prefix);

        let maxrate_str = overrides.as_ref().and_then(|ov| ov.maxrate.clone()).unwrap_or_else(|| self.config.video.bitrate_target.clone());
        let maxrate_k = parse_bitrate_k(&maxrate_str).unwrap_or(4000).max(1);
        let target_k = (maxrate_k as f64 * 0.7).ceil() as u32;

        let mut video_cfg = self.config.video.clone();
        video_cfg.bitrate_target = format!("{}k", target_k);
        video_cfg.bitrate_max = format!("{}k", maxrate_k);

        if let Some(enc) = encoder_selected.as_deref() {
            video_cfg.encoder = enc.to_string();
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Membangun Master Audio Pool...".into() });

        let master_pool = audio_pool::build_master_audio_pool(
            &self.app,
            &cache_dir,
            &audio_files,
            &self.config.audio,
            Some(control.clone()),
        )
        .await?;

        if master_pool.is_empty() {
            return Err(AppError::NoAudio);
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: format!("{} lagu siap digunakan.", master_pool.len()) });

        let mut initial_jobs = if resume && state_path.exists() {
            match tokio::fs::read_to_string(&state_path).await {
                Ok(content) => match serde_json::from_str::<Vec<RenderJob>>(&content) {
                    Ok(mut saved_jobs) => {
                        for j in &mut saved_jobs {
                            if j.state != JobState::Done {
                                j.state = JobState::Pending;
                                j.progress_percent = 0;
                                j.current_step = "Pending".into();
                                j.error = None;
                            }
                        }
                        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Melanjutkan state render sebelumnya...".into() });
                        saved_jobs
                    }
                    Err(_) => self.create_initial_jobs(&video_files, &safe_prefix, &output_dir),
                },
                Err(_) => self.create_initial_jobs(&video_files, &safe_prefix, &output_dir),
            }
        } else {
            self.create_initial_jobs(&video_files, &safe_prefix, &output_dir)
        };

        if !resume {
            event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: "Generating thumbnails...".into() });
            self.generate_thumbnails(&mut initial_jobs, &thumb_dir, render_timestamp, control.clone()).await;
        }

        if control.is_cancelled() || control.is_paused() {
            let _ = self.save_state(&state_path, &initial_jobs).await;
            return Err(AppError::Cancelled("Render dibatalkan/dipause oleh pengguna".into()));
        }

        let jobs_arc = Arc::new(tokio::sync::Mutex::new(initial_jobs));
        self.emit_progress_from_arc(&jobs_arc).await;

        let total_jobs = jobs_arc.lock().await.len();
        let pipeline_arc = Arc::new(self);
        let encoder_arc = encoder_selected.map(Arc::new);

        let indices: Vec<usize> = (0..total_jobs).collect();
        let stream = futures::stream::iter(indices);

        stream.for_each_concurrent(max_concurrent_jobs, |i| {
            let p_arc = Arc::clone(&pipeline_arc);
            let j_arc = Arc::clone(&jobs_arc);
            let cache_clone = cache_dir.clone();
            let c_clone = control.clone();
            let vcfg_clone = video_cfg.clone();
            let e_arc = encoder_arc.clone();
            let m_pool = master_pool.clone();
            let s_path = state_path.clone();
            let w_path = watermark_path.clone();

            async move {
                if c_clone.is_cancelled() || c_clone.is_paused() {
                    return;
                }

                let skip = {
                    let mut lock = j_arc.lock().await;
                    if Path::new(&lock[i].video.output_path).exists() && lock[i].state == JobState::Done {
                        true
                    } else if Path::new(&lock[i].video.output_path).exists() && !resume {
                        lock[i].state = JobState::Done;
                        lock[i].progress_percent = 100;
                        lock[i].current_step = "Skipped".into();
                        event::emit(
                            &p_arc.app,
                            PipelineEvent::Log { level: "info".into(), message: format!("Melewati {} (sudah ada)", lock[i].video.name) },
                        );
                        true
                    } else {
                        false
                    }
                };

                if skip {
                    p_arc.emit_progress_from_arc(&j_arc).await;
                    let _ = p_arc.save_state_from_arc(&s_path, &j_arc).await;
                    return;
                }

                let e_str = e_arc.as_deref().map(|s| s.as_ref());

                let result = p_arc.process_single_job(
                    i,
                    &j_arc,
                    &cache_clone,
                    render_timestamp,
                    use_pingpong,
                    &vcfg_clone,
                    e_str,
                    &m_pool,
                    songs_per_playlist,
                    min_duration_sec,
                    youtube_timestamps,
                    w_path.as_ref(),
                    watermark_opacity,
                    c_clone.clone(),
                ).await;

                match result {
                    Ok(()) => {
                        event::emit(
                            &p_arc.app,
                            PipelineEvent::Log { level: "success".into(), message: format!("Job {} selesai", i) },
                        );
                    }
                    Err(AppError::Cancelled(_)) => {}
                    Err(e) => {
                        {
                            let mut lock = j_arc.lock().await;
                            lock[i].state = JobState::Error;
                            lock[i].error = Some(e.to_string());
                        }
                        p_arc.emit_progress_from_arc(&j_arc).await;
                    }
                }
                
                let _ = p_arc.save_state_from_arc(&s_path, &j_arc).await;
            }
        }).await;

        if control.is_paused() {
            return Err(AppError::Cancelled("Render dipause oleh pengguna".into()));
        } else if control.is_cancelled() {
            let _ = tokio::fs::remove_file(&state_path).await;
            return Err(AppError::Cancelled("Render dibatalkan oleh pengguna".into()));
        }

        let _ = tokio::fs::remove_dir_all(&cache_dir).await;
        let _ = tokio::fs::remove_file(&state_path).await;

        let final_jobs = jobs_arc.lock().await.clone();

        let youtube_timestamps = overrides.as_ref().and_then(|ov| ov.youtube_timestamps).unwrap_or(pipeline_arc.config.youtube_timestamps);
        if youtube_timestamps && !final_jobs.is_empty() {
            let mut all_timestamps = Vec::new();
            for job in &final_jobs {
                if !job.timestamps.is_empty() {
                    all_timestamps.extend(job.timestamps.clone());
                    all_timestamps.push("".into());
                }
            }
            let parent_opt = final_jobs.first().map(|j| &j.video.output_path).and_then(|p| Path::new(p).parent());
            if let Some(parent) = parent_opt.filter(|_| !all_timestamps.is_empty()) {
                let combined_path = parent.join("all_timestamps.txt");
                let _ = tokio::fs::write(&combined_path, all_timestamps.join("\n")).await;
            }
        }
        let failed = final_jobs.iter().filter(|j| j.state == JobState::Error).count();
        let completed = final_jobs.iter().filter(|j| j.state == JobState::Done).count();

        event::emit(
            &pipeline_arc.app,
            PipelineEvent::Log {
                level: "info".into(),
                message: format!("Render selesai: {}/{} sukses, {} gagal", completed, total_jobs, failed),
            },
        );
        event::emit(&pipeline_arc.app, PipelineEvent::Done { completed, total: total_jobs, failed });
        Ok(())
    }

    async fn save_state(&self, state_path: &Path, jobs: &[RenderJob]) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(jobs).unwrap_or_default();
        tokio::fs::write(state_path, json).await.map_err(|e| AppError::Pipeline(e.to_string()))
    }

    async fn save_state_from_arc(&self, state_path: &Path, jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>) -> Result<(), AppError> {
        let jobs = jobs_arc.lock().await.clone();
        self.save_state(state_path, &jobs).await
    }

    async fn emit_progress_from_arc(&self, jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>) {
        let jobs = jobs_arc.lock().await.clone();
        let total = jobs.len();
        let completed = jobs.iter().filter(|j| j.state == JobState::Done).count();
        let current_video = jobs.iter().find(|j| j.state == JobState::Processing).map(|j| j.video.name.clone()).unwrap_or_default();
        event::emit(
            &self.app,
            PipelineEvent::Progress { total, completed, current_video, jobs },
        );
    }

    fn create_initial_jobs(&self, video_files: &[String], safe_prefix: &str, output_dir: &Path) -> Vec<RenderJob> {
        let mut jobs = Vec::new();
        for path_str in video_files {
            let input_path = Path::new(path_str);
            let name = input_path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let output_name = if safe_prefix.is_empty() { name.clone() } else { format!("{}_{}", safe_prefix, name) };
            jobs.push(RenderJob {
                video: VideoFile {
                    name: name.clone(),
                    input_path: path_str.clone(),
                    output_path: output_dir.join(&output_name).to_string_lossy().to_string(),
                    thumbnail_path: None,
                },
                state: JobState::Pending,
                progress_percent: 0,
                current_step: "Menunggu giliran".into(),
                error: None,
                timestamps: Vec::new(),
            });
        }
        jobs
    }

    async fn generate_thumbnails(&self, jobs: &mut [RenderJob], thumb_dir: &Path, render_timestamp: u64, control: Arc<crate::RenderControl>) {
        let indices_and_paths: Vec<(usize, String)> = jobs.iter().enumerate().map(|(i, j)| (i, j.video.input_path.clone())).collect();
        let stream = futures::stream::iter(indices_and_paths);
        
        stream.for_each_concurrent(4, |(i, input_path)| {
            let thumb_path = thumb_dir.join(format!("thumb_{}_{}.jpg", render_timestamp, i));
            let control_clone = control.clone();
            async move {
                if !thumb_path.exists() {
                    let args = vec![
                        "-y".into(), "-ss".into(), "00:00:01".into(), "-i".into(), input_path,
                        "-vframes".into(), "1".into(), "-vf".into(), "scale=320:-1".into(),
                        thumb_path.to_string_lossy().to_string(),
                    ];
                    let _ = ffmpeg::run(&args, None, Some(control_clone)).await;
                }
            }
        }).await;

        for (i, job) in jobs.iter_mut().enumerate() {
            let thumb_path = thumb_dir.join(format!("thumb_{}_{}.jpg", render_timestamp, i));
            if thumb_path.exists() {
                job.video.thumbnail_path = Some(thumb_path.to_string_lossy().to_string());
            }
        }
    }

    async fn process_single_job(
        &self,
        i: usize,
        jobs_arc: &Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
        cache_dir: &Path,
        render_timestamp: u64,
        use_pingpong: bool,
        video_cfg: &crate::config::VideoSettings,
        encoder_selected: Option<&str>,
        master_pool: &[ProcessedAudio],
        songs_per_playlist: usize,
        min_duration_sec: u64,
        youtube_timestamps: bool,
        watermark_path: Option<&String>,
        watermark_opacity: f32,
        control: Arc<crate::RenderControl>,
    ) -> Result<(), AppError> {
        {
            let mut lock = jobs_arc.lock().await;
            lock[i].state = JobState::Processing;
            lock[i].current_step = "Preparing".into();
        }
        self.emit_progress_from_arc(jobs_arc).await;

        let timestamp = format!("{}_{}", render_timestamp, i);
        let input_path = {
            let lock = jobs_arc.lock().await;
            lock[i].video.input_path.clone()
        };
        let output_path = {
            let lock = jobs_arc.lock().await;
            lock[i].video.output_path.clone()
        };
        let name = {
            let lock = jobs_arc.lock().await;
            lock[i].video.name.clone()
        };

        let input_codec = ffmpeg::get_video_codec(Path::new(&input_path)).await.ok();

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
        let target_dur = ffmpeg::get_duration(Path::new(&input_path)).await.unwrap_or(1.0).max(0.001) * if use_pingpong { 2.0 } else { 1.0 };

        if use_pingpong || need_reencode || watermark_path.is_some() {
            {
                let mut lock = jobs_arc.lock().await;
                lock[i].current_step = if use_pingpong { "1/2 Upscaling & Ping-Pong".into() } else { "1/2 Re-encode video".into() };
            }
            self.emit_progress_from_arc(jobs_arc).await;

            ping_pong_path = cache_dir.join(format!("intermediate_{}.mp4", timestamp));
            created_intermediate = true;

            let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);

            let ffmpeg_task = tokio::spawn({
                let input_clone = input_path.clone();
                let ping_pong_path_clone = ping_pong_path.clone();
                let video_cfg_clone = video_cfg.clone();
                let control_clone = control.clone();
                let wm_clone = watermark_path.cloned();
                async move {
                    video_loop::create_ping_pong_video(video_loop::PingPongVideoParams {
                        input: &input_clone,
                        output: &ping_pong_path_clone,
                        video_settings: &video_cfg_clone,
                        use_pingpong,
                        watermark_path: wm_clone.as_ref(),
                        watermark_opacity,
                        tx_progress: Some(tx),
                        cancel_control: Some(control_clone),
                    }).await
                }
            });

            while let Some(progress_sec) = rx.recv().await {
                let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
                {
                    let mut lock = jobs_arc.lock().await;
                    lock[i].progress_percent = pct / 2;
                }
                self.emit_progress_from_arc(jobs_arc).await;
            }

            match ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e)))) {
                Ok(()) => {}
                Err(e) => {
                    let _ = fs::safe_delete(&ping_pong_path).await;
                    return Err(e);
                }
            }
        } else {
            {
                let mut lock = jobs_arc.lock().await;
                lock[i].current_step = "1/2 Menggunakan video asli".into();
            }
            self.emit_progress_from_arc(jobs_arc).await;
            ping_pong_path = PathBuf::from(&input_path);
            created_intermediate = false;
        }

        {
            let mut lock = jobs_arc.lock().await;
            lock[i].current_step = "2/2 Smart Loop & Muxing".into();
            lock[i].progress_percent = if created_intermediate { 50 } else { 0 };
        }
        self.emit_progress_from_arc(jobs_arc).await;

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
                target_dur,
                &target_override,
                youtube_timestamps,
            )
            .await?;

        {
            let mut lock = jobs_arc.lock().await;
            lock[i].timestamps = timestamps.clone();
        }

        event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: format!("=== Timestamps untuk {} ===", name) });
        for ts in &timestamps {
            event::emit(&self.app, PipelineEvent::Log { level: "info".into(), message: ts.clone() });
        }

        let audio_list_path = cache_dir.join(format!("audio_list_{}.txt", timestamp));
        let video_list_path = cache_dir.join(format!("video_list_{}.txt", timestamp));
        tokio::fs::write(&audio_list_path, &audio_content).await?;
        tokio::fs::write(&video_list_path, &video_content).await?;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
        let ffmpeg_task = tokio::spawn({
            let audio_list_path_clone = audio_list_path.clone();
            let video_list_path_clone = video_list_path.clone();
            let output_path_clone = output_path.clone();
            let control_clone = control.clone();
            async move {
                muxer::mux_final_video(
                    &audio_list_path_clone,
                    &video_list_path_clone,
                    &output_path_clone,
                    total_duration,
                    Some(tx),
                    Some(control_clone),
                ).await
            }
        });

        while let Some(progress_sec) = rx.recv().await {
            let pct = (progress_sec / total_duration * 100.0).clamp(0.0, 100.0) as u8;
            {
                let mut lock = jobs_arc.lock().await;
                lock[i].progress_percent = if created_intermediate { 50 + (pct / 2) } else { pct };
            }
            self.emit_progress_from_arc(jobs_arc).await;
        }

        let res = ffmpeg_task.await.unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))));

        if created_intermediate { let _ = fs::safe_delete(&ping_pong_path).await; }
        let _ = fs::safe_delete(&audio_list_path).await;
        let _ = fs::safe_delete(&video_list_path).await;

        match res {
            Ok(()) => {
                {
                    let mut lock = jobs_arc.lock().await;
                    lock[i].state = JobState::Done;
                    lock[i].progress_percent = 100;
                }
                self.emit_progress_from_arc(jobs_arc).await;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    fn resolve_output_dir(&self, overrides: &Option<OverrideConfig>) -> PathBuf {
        if let Some(path) = overrides.as_ref().and_then(|ov| ov.output_path.as_ref()) {
            return PathBuf::from(path);
        }
        PathBuf::from(&self.config.directories.output)
    }

    async fn scan_source_files(&self, overrides: &Option<OverrideConfig>, default_dir: &Path, media_type: &str) -> Result<Vec<String>, AppError> {
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
            Some(MediaSource::Folder { path }) => fs::scan_files(&fs::to_absolute(Path::new(path)), extensions).await,
            Some(MediaSource::Files { paths }) => {
                let mut all_files = Vec::new();
                for p_str in paths {
                    let p = fs::to_absolute(Path::new(p_str));
                    if p.is_dir() { all_files.extend(fs::scan_files(&p, extensions).await); }
                    else if p.is_file() {
                        let lower = p_str.to_lowercase();
                        if extensions.iter().any(|ext| lower.ends_with(ext)) { all_files.push(p.to_string_lossy().to_string()); }
                    }
                }
                all_files
            }
            None => fs::scan_files(&fs::to_absolute(Path::new(default_dir)), extensions).await,
        };
        files.sort_by(|a, b| fs::compare_natural(a, b));
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
    value.chars().filter(|c| !c.is_control()).map(|c| match c {
        '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
        _ => c,
    }).collect::<String>().trim().trim_matches('.').to_string()
}
