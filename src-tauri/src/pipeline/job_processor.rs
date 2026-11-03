use super::{muxer, state::StateManager, video_loop};
use crate::error::AppError;
use crate::ffmpeg;
use crate::models::job::{JobState, RenderJob, RenderStats};
use crate::models::media::ProcessedAudio;
use crate::utils::fs;
use rand::SeedableRng;
use rand::prelude::SliceRandom;
use rand::rngs::{StdRng, SysRng};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

/// Runtime context for a single render job — grouped so
/// `process_single_job`'s parameter list stays manageable.
pub struct JobContext<'a> {
    pub(crate) index: usize,
    pub(crate) jobs_arc: &'a Arc<tokio::sync::Mutex<Vec<RenderJob>>>,
    pub(crate) cache_dir: &'a Path,
    pub(crate) render_timestamp: u64,
    pub(crate) control: Arc<crate::RenderControl>,
    pub(crate) stats_tx: Option<tokio::sync::mpsc::Sender<RenderStats>>,
}

/// Static configuration for a single render job — extracted into a struct
/// so `process_single_job` doesn't need 15 individual parameters.
pub struct JobParams {
    pub(crate) use_pingpong: bool,
    pub(crate) skip_intermediate_on_codec_match: bool,
    pub(crate) video_cfg: crate::config::VideoSettings,
    pub(crate) master_pool: Arc<Vec<ProcessedAudio>>,
    pub(crate) songs_per_playlist: usize,
    pub(crate) min_duration_sec: u64,
    pub(crate) loop_count: Option<usize>,
    pub(crate) embed_chapters: bool,
}

pub(crate) async fn process_single_job(
    app: &AppHandle,
    state_manager: &StateManager,
    padding_sec: u64,
    ctx: JobContext<'_>,
    params: JobParams,
) -> Result<(), AppError> {
    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].state = JobState::Processing;
        lock[ctx.index].current_step = "Preparing".into();
    }
    state_manager
        .emit_progress_from_arc(app, ctx.jobs_arc)
        .await;

    let timestamp = format!("{}_{}", ctx.render_timestamp, ctx.index);
    let (input_path, output_path, name) = {
        let lock = ctx.jobs_arc.lock().await;
        (
            lock[ctx.index].video.input_path.clone(),
            lock[ctx.index].video.output_path.clone(),
            lock[ctx.index].video.name.clone(),
        )
    };

    // Single ffprobe call for duration and frame rate instead of two separate
    // subprocess invocations. Fall back to the standalone duration probe if the
    // combined probe fails.
    let (input_fps, input_duration) =
        match ffmpeg::get_video_info(app, Path::new(&input_path)).await {
            Ok(info) => (info.frame_rate, Ok(info.duration)),
            Err(_) => (
                30.0,
                ffmpeg::get_duration(app, Path::new(&input_path)).await,
            ),
        };
    let input_duration = input_duration
        .map_err(|_| AppError::Pipeline(format!("Failed to detect video duration: {}", name)))?;

    let ping_pong_path;
    let created_intermediate;
    let target_dur = input_duration.max(0.001) * if params.use_pingpong { 2.0 } else { 1.0 };

    // `skip_intermediate_on_codec_match` is an unconditional stream-copy
    // switch (the name is historical — it used to gate on a codec match).
    // ON = feed the source straight into the concat demuxer, no re-encode.
    let needs_intermediate = !params.skip_intermediate_on_codec_match;

    if needs_intermediate {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = if params.use_pingpong {
                "1/2 Upscaling & ping-pong".into()
            } else {
                "1/2 Re-encoding video".into()
            };
        }
        state_manager
            .emit_progress_from_arc(app, ctx.jobs_arc)
            .await;

        ping_pong_path = ctx
            .cache_dir
            .join(format!("intermediate_{}.mp4", timestamp));
        created_intermediate = true;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);

        let stats_tx_ping = ctx.stats_tx.clone();
        let pingpong = params.use_pingpong;
        let ffmpeg_task = tokio::spawn({
            let input_clone = input_path.clone();
            let ping_pong_path_clone = ping_pong_path.clone();
            let video_cfg_clone = params.video_cfg.clone();
            let control_clone = ctx.control.clone();
            let fps_clone = input_fps;
            let app_clone = app.clone();
            async move {
                video_loop::create_ping_pong_video(video_loop::PingPongVideoParams {
                    app: &app_clone,
                    input: &input_clone,
                    output: &ping_pong_path_clone,
                    video_settings: &video_cfg_clone,
                    use_pingpong: pingpong,
                    fps: fps_clone,
                    tx_progress: Some(tx),
                    cancel_control: Some(control_clone),
                    tx_stats: stats_tx_ping,
                })
                .await
            }
        });

        while let Some(progress_sec) = rx.recv().await {
            let pct = (progress_sec / target_dur * 100.0).clamp(0.0, 100.0) as u8;
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].progress_percent = pct / 2;
            }
            state_manager
                .emit_progress_throttled(app, ctx.jobs_arc)
                .await;
        }

        match ffmpeg_task
            .await
            .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))))
        {
            Ok(()) => {}
            Err(e) => {
                fs::cleanup_temp_file(&ping_pong_path).await;
                return Err(e);
            }
        }
    } else {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = "1/2 Using original video".into();
        }
        state_manager
            .emit_progress_from_arc(app, ctx.jobs_arc)
            .await;
        ping_pong_path = PathBuf::from(&input_path);
        created_intermediate = false;
    }

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].current_step = "2/2 Smart loop & muxing".into();
        lock[ctx.index].progress_percent = if created_intermediate { 50 } else { 0 };
    }
    state_manager
        .emit_progress_from_arc(app, ctx.jobs_arc)
        .await;

    // `try_from_rng(&mut SysRng)` seeds from the OS RNG (the panic-free
    // Result form recommended for rand 0.10). The fallback only triggers on
    // an essentially-impossible OS RNG failure and avoids any `.unwrap()`
    // that could panic the task.
    let mut rng = StdRng::try_from_rng(&mut SysRng)
        .unwrap_or_else(|_| StdRng::seed_from_u64(rand::random::<u64>()));
    // Shuffle *indices* instead of cloning the entire master pool just to
    // pick `songs_per_playlist` tracks. This avoids an O(pool_size)
    // allocation (and a copy of every ProcessedAudio) on every job.
    let mut indices: Vec<usize> = (0..params.master_pool.len()).collect();
    indices.shuffle(&mut rng);
    let take_count = params
        .songs_per_playlist
        .min(params.master_pool.len())
        .max(1);
    let selected_songs: Vec<ProcessedAudio> = indices
        .into_iter()
        .take(take_count)
        .map(|i| params.master_pool[i].clone())
        .collect();

    let target_override = crate::config::Target {
        min_duration_sec: params.min_duration_sec,
        padding_sec,
    };
    let audio_list_path = ctx.cache_dir.join(format!("audio_list_{}.txt", timestamp));
    let video_list_path = ctx.cache_dir.join(format!("video_list_{}.txt", timestamp));

    // `generate_loop_playlists` now writes the concat playlists directly
    // to disk via a BufWriter instead of returning giant Strings — this
    // avoids allocating tens of megabytes on the heap for long renders.
    let (timestamps, chapters, total_duration) = match video_loop::generate_loop_playlists(
        app,
        &selected_songs,
        &ping_pong_path,
        target_dur,
        &target_override,
        params.loop_count,
        &audio_list_path,
        &video_list_path,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if created_intermediate {
                fs::cleanup_temp_file(&ping_pong_path).await;
            }
            fs::cleanup_temp_file(&audio_list_path).await;
            fs::cleanup_temp_file(&video_list_path).await;
            return Err(error);
        }
    };

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].timestamps = timestamps.clone();
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
    let stats_tx_mux = ctx.stats_tx.clone();
    let ffmpeg_task = tokio::spawn({
        let audio_list_path_clone = audio_list_path.clone();
        let video_list_path_clone = video_list_path.clone();
        let output_path_clone = output_path.clone();
        let cache_dir_clone = ctx.cache_dir.to_path_buf();
        let chapters_clone = chapters.clone();
        let control_clone = ctx.control.clone();
        let app_clone = app.clone();
        async move {
            muxer::mux_final_video(
                &app_clone,
                &audio_list_path_clone,
                &video_list_path_clone,
                &output_path_clone,
                total_duration,
                &cache_dir_clone,
                params.embed_chapters,
                &chapters_clone,
                Some(tx),
                Some(control_clone),
                stats_tx_mux,
            )
            .await
        }
    });

    while let Some(progress_sec) = rx.recv().await {
        let pct = (progress_sec / total_duration * 100.0).clamp(0.0, 100.0) as u8;
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].progress_percent = if created_intermediate {
                50 + (pct / 2)
            } else {
                pct
            };
        }
        state_manager
            .emit_progress_throttled(app, ctx.jobs_arc)
            .await;
    }

    let res = ffmpeg_task
        .await
        .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {}", e))));

    if created_intermediate {
        fs::cleanup_temp_file(&ping_pong_path).await;
    }
    fs::cleanup_temp_file(&audio_list_path).await;
    fs::cleanup_temp_file(&video_list_path).await;

    match res {
        Ok(()) => {
            {
                let mut lock = ctx.jobs_arc.lock().await;
                lock[ctx.index].state = JobState::Done;
                lock[ctx.index].progress_percent = 100;
            }
            state_manager
                .emit_progress_from_arc(app, ctx.jobs_arc)
                .await;
            Ok(())
        }
        Err(e) => Err(e),
    }
}
