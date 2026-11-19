use super::{muxer, state::StateManager, video_loop};
use crate::config::Target;
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

struct IntermediateRequest<'a, 'ctx> {
    app: &'a AppHandle,
    state_manager: &'a StateManager,
    ctx: &'a JobContext<'ctx>,
    params: &'a JobParams,
    timestamp: &'a str,
    input_path: &'a str,
    target_dur: f64,
    input_fps: f64,
}

struct PlaylistRequest<'a> {
    app: &'a AppHandle,
    params: &'a JobParams,
    ping_pong_path: &'a Path,
    created_intermediate: bool,
    target_dur: f64,
    target: &'a Target,
    audio_list_path: &'a Path,
    video_list_path: &'a Path,
}

struct MuxRequest<'a, 'ctx> {
    app: &'a AppHandle,
    state_manager: &'a StateManager,
    ctx: &'a JobContext<'ctx>,
    output_path: &'a str,
    intermediate_path: &'a Path,
    created_intermediate: bool,
    audio_list_path: &'a Path,
    video_list_path: &'a Path,
    total_duration: f64,
    chapters: &'a str,
    embed_chapters: bool,
}

/// Probe frame rate and duration in one ffprobe round-trip, falling back to
/// the duration-only probe if the combined call fails.
async fn probe_video(
    app: &AppHandle,
    input_path: &str,
    name: &str,
) -> Result<(f64, f64), AppError> {
    let (frame_rate, duration) = match ffmpeg::get_video_info(app, Path::new(input_path)).await {
        Ok(info) => (info.frame_rate, Ok(info.duration)),
        Err(_) => (30.0, ffmpeg::get_duration(app, Path::new(input_path)).await),
    };
    let duration = duration
        .map_err(|_| AppError::Pipeline(format!("Failed to detect video duration: {name}")))?;
    Ok((frame_rate, duration))
}

/// Shuffle indices instead of cloning the whole master pool just to pick
/// `songs_per_playlist` tracks.
fn select_songs(master_pool: &[ProcessedAudio], songs_per_playlist: usize) -> Vec<ProcessedAudio> {
    let mut rng = StdRng::try_from_rng(&mut SysRng)
        .unwrap_or_else(|_| StdRng::seed_from_u64(rand::random::<u64>()));
    let mut indices: Vec<usize> = (0..master_pool.len()).collect();
    indices.shuffle(&mut rng);
    let take_count = songs_per_playlist.min(master_pool.len()).max(1);
    indices
        .into_iter()
        .take(take_count)
        .map(|i| master_pool[i].clone())
        .collect()
}

/// Create the re-encoded intermediate, or reuse the source directly when the
/// user enabled the stream-copy path. Returns the path plus whether the file
/// is a disposable intermediate.
async fn prepare_intermediate(
    req: IntermediateRequest<'_, '_>,
) -> Result<(PathBuf, bool), AppError> {
    let IntermediateRequest {
        app,
        state_manager,
        ctx,
        params,
        timestamp,
        input_path,
        target_dur,
        input_fps,
    } = req;

    if params.skip_intermediate_on_codec_match {
        {
            let mut lock = ctx.jobs_arc.lock().await;
            lock[ctx.index].current_step = "1/2 Using original video".into();
        }
        state_manager
            .emit_progress_from_arc(app, ctx.jobs_arc)
            .await;
        return Ok((PathBuf::from(input_path), false));
    }

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

    let ping_pong_path = ctx.cache_dir.join(format!("intermediate_{timestamp}.mp4"));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
    let stats_tx_ping = ctx.stats_tx.clone();
    let pingpong = params.use_pingpong;
    let video_cfg_clone = params.video_cfg.clone();
    let control_clone = ctx.control.clone();
    let app_clone = app.clone();
    let input_clone = input_path.to_owned();
    let output_clone = ping_pong_path.clone();
    let ffmpeg_task = tokio::spawn(async move {
        video_loop::create_ping_pong_video(video_loop::PingPongVideoParams {
            app: &app_clone,
            input: &input_clone,
            output: &output_clone,
            video_settings: &video_cfg_clone,
            use_pingpong: pingpong,
            fps: input_fps,
            tx_progress: Some(tx),
            cancel_control: Some(control_clone),
            tx_stats: stats_tx_ping,
        })
        .await
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
        .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {e}"))))
    {
        Ok(()) => Ok((ping_pong_path, true)),
        Err(error) => {
            fs::cleanup_temp_file(&ping_pong_path).await;
            Err(error)
        }
    }
}

/// Generate the concat playlists. On failure, remove the intermediate and
/// any partially written playlist files.
async fn build_playlists(req: PlaylistRequest<'_>) -> Result<(Vec<String>, String, f64), AppError> {
    let PlaylistRequest {
        app,
        params,
        ping_pong_path,
        created_intermediate,
        target_dur,
        target,
        audio_list_path,
        video_list_path,
    } = req;
    let selected_songs = select_songs(&params.master_pool, params.songs_per_playlist);
    let result = video_loop::generate_loop_playlists(
        app,
        &selected_songs,
        ping_pong_path,
        target_dur,
        target,
        params.loop_count,
        audio_list_path,
        video_list_path,
    )
    .await;
    match result {
        Ok(playlists) => Ok(playlists),
        Err(error) => {
            if created_intermediate {
                fs::cleanup_temp_file(ping_pong_path).await;
            }
            fs::cleanup_temp_file(audio_list_path).await;
            fs::cleanup_temp_file(video_list_path).await;
            Err(error)
        }
    }
}

/// Run the final mux, stream progress, clean up render artifacts, and mark the
/// job done on success.
async fn run_mux(req: MuxRequest<'_, '_>) -> Result<(), AppError> {
    let MuxRequest {
        app,
        state_manager,
        ctx,
        output_path,
        intermediate_path,
        created_intermediate,
        audio_list_path,
        video_list_path,
        total_duration,
        chapters,
        embed_chapters,
    } = req;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<f64>(100);
    let stats_tx_mux = ctx.stats_tx.clone();
    let audio = audio_list_path.to_path_buf();
    let video = video_list_path.to_path_buf();
    let output = output_path.to_owned();
    let cache = ctx.cache_dir.to_path_buf();
    let chapters = chapters.to_owned();
    let control = ctx.control.clone();
    let app_clone = app.clone();
    let ffmpeg_task = tokio::spawn(async move {
        muxer::mux_final_video(
            &app_clone,
            &audio,
            &video,
            &output,
            total_duration,
            &cache,
            embed_chapters,
            &chapters,
            Some(tx),
            Some(control),
            stats_tx_mux,
        )
        .await
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

    let result = ffmpeg_task
        .await
        .unwrap_or_else(|e| Err(AppError::Pipeline(format!("Task panic: {e}"))));

    if created_intermediate {
        fs::cleanup_temp_file(intermediate_path).await;
    }
    fs::cleanup_temp_file(audio_list_path).await;
    fs::cleanup_temp_file(video_list_path).await;
    result?;

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

    let (input_fps, input_duration) = probe_video(app, &input_path, &name).await?;
    let target_dur = input_duration.max(0.001) * if params.use_pingpong { 2.0 } else { 1.0 };

    let (ping_pong_path, created_intermediate) = prepare_intermediate(IntermediateRequest {
        app,
        state_manager,
        ctx: &ctx,
        params: &params,
        timestamp: &timestamp,
        input_path: &input_path,
        target_dur,
        input_fps,
    })
    .await?;

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].current_step = "2/2 Smart loop & muxing".into();
        lock[ctx.index].progress_percent = if created_intermediate { 50 } else { 0 };
    }
    state_manager
        .emit_progress_from_arc(app, ctx.jobs_arc)
        .await;

    let target_override = Target {
        min_duration_sec: params.min_duration_sec,
        padding_sec,
    };
    let audio_list_path = ctx.cache_dir.join(format!("audio_list_{timestamp}.txt"));
    let video_list_path = ctx.cache_dir.join(format!("video_list_{timestamp}.txt"));

    let (timestamps, chapters, total_duration) = build_playlists(PlaylistRequest {
        app,
        params: &params,
        ping_pong_path: &ping_pong_path,
        created_intermediate,
        target_dur,
        target: &target_override,
        audio_list_path: &audio_list_path,
        video_list_path: &video_list_path,
    })
    .await?;

    {
        let mut lock = ctx.jobs_arc.lock().await;
        lock[ctx.index].timestamps = timestamps;
    }

    run_mux(MuxRequest {
        app,
        state_manager,
        ctx: &ctx,
        output_path: &output_path,
        intermediate_path: &ping_pong_path,
        created_intermediate,
        audio_list_path: &audio_list_path,
        video_list_path: &video_list_path,
        total_duration,
        chapters: &chapters,
        embed_chapters: params.embed_chapters,
    })
    .await
}
