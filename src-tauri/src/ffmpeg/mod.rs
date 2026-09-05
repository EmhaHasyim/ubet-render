mod parsing;

pub(crate) use parsing::{
    MIN_FFMPEG_VERSION, extract_time, parse_audio_probe_value, parse_ffmpeg_version,
    parse_ffprobe_frame_rate, parse_loudnorm_measurement, parse_stats, version_meets_minimum,
};

/// Combined video metadata probe — returns duration, codec, and frame rate
/// from a single ffprobe invocation instead of three separate subprocess calls.
pub struct VideoInfo {
    pub duration: f64,
    pub codec: Option<String>,
    pub frame_rate: f64,
}

use std::ffi::OsStr;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use crate::error::AppError;
use crate::models::job::RenderStats;
use crate::models::media::{AudioInfo, LoudnormMeasurement};

const DEFAULT_PROCESS_TIMEOUT_SEC: u64 = 86_400;
const PROBE_TIMEOUT_SEC: u64 = 60;
const LOUDNORM_IDLE_TIMEOUT_SEC: u64 = 300;

struct ChildGuard(Option<CommandChild>);

impl ChildGuard {
    fn terminate(&mut self) {
        if let Some(child) = self.0.take() {
            terminate_child(child);
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Terminate FFmpeg and, on Windows, its descendant process tree.
///
/// `CommandChild::kill()` only targets the direct process. FFmpeg normally
/// remains a single process, but a bundled/helper invocation can create
/// descendants; `taskkill /T /F` gives cancellation and timeout a stronger
/// Windows guarantee. The direct kill remains the fallback if the system tool
/// is unavailable or reports failure.
fn terminate_child(child: CommandChild) {
    #[cfg(windows)]
    {
        let pid = child.pid().to_string();
        let taskkill = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .map(|root| root.join("System32").join("taskkill.exe"))
            .unwrap_or_else(|| std::path::PathBuf::from("taskkill.exe"));
        let mut taskkill_command = std::process::Command::new(taskkill);
        taskkill_command.args(["/PID", &pid, "/T", "/F"]);
        taskkill_command.creation_flags(CREATE_NO_WINDOW);
        let tree_killed = taskkill_command
            .status()
            .is_ok_and(|status| status.success());
        if !tree_killed {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

pub async fn run<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: &[S],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
    tx_stats: Option<tokio::sync::mpsc::Sender<RenderStats>>,
) -> Result<(), AppError> {
    run_with_timeout(
        app,
        args,
        tx_progress,
        cancel_control,
        tx_stats,
        DEFAULT_PROCESS_TIMEOUT_SEC,
    )
    .await
}

pub async fn run_with_timeout<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: &[S],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
    tx_stats: Option<tokio::sync::mpsc::Sender<RenderStats>>,
    max_timeout_sec: u64,
) -> Result<(), AppError> {
    if let Some(ref control) = cancel_control {
        // Mirror the in-loop handling below: a pause must *terminate* this ffmpeg
        // run (so the pipeline can save state and finish) rather than block
        // waiting for resume. Cancel takes precedence, as below.
        control.ensure_running()?;
    }
    let sidecar_command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    // This guard kills the child process on drop (including on panic / early
    // return). The variable IS used — its Drop impl is the intended side-effect.
    let mut child_guard = ChildGuard(Some(child));

    let mut last_stderr = "Unknown ffmpeg error".to_string();
    let timeout_dur = std::time::Duration::from_secs(max_timeout_sec.max(1));
    let idle_timeout = std::time::Duration::from_secs(LOUDNORM_IDLE_TIMEOUT_SEC);
    // Keep a fixed absolute deadline. Activity may reset the idle deadline,
    // but must never extend the total lifetime of a render indefinitely.
    let absolute_deadline = tokio::time::Instant::now() + timeout_dur;
    let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;
    // Per-invocation stats-drop warning (resets every run; previously a
    // process-wide `static` that warned only once per session).
    let mut stats_drop_warned = false;
    loop {
        if let Some(ref control) = cancel_control
            && let Err(e) = control.ensure_running()
        {
            child_guard.terminate();
            return Err(e);
        }

        tokio::select! {
            _ = tokio::time::sleep_until(absolute_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!("FFmpeg process timed out ({}s limit)", max_timeout_sec)));
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!("FFmpeg process idle timeout ({}s limit)", LOUDNORM_IDLE_TIMEOUT_SEC)));
            }
            event_res = rx.recv() => {
                match event_res {
                    Some(CommandEvent::Stderr(line_bytes)) => {
                        // Use Cow<str> to avoid allocation for valid UTF-8 (typical case),
                        // only allocating for the rare invalid-UTF-8 scenario
                        let line_cow = String::from_utf8_lossy(&line_bytes);
                        // Every stderr line proves the process is still alive, so reset
                        // the deadline immediately regardless of whether it carries
                        // progress or metadata. This prevents a false timeout when
                        // ffmpeg outputs frame-type-specific log lines that don't
                        // contain `time=` or `speed=` tokens.
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                        if let (Some(tx), Some(time_sec)) = (&tx_progress, extract_time(&line_cow)) {
                            // Progress is advisory; never block stderr monitoring
                            // behind a slow UI consumer and thereby defeat the
                            // absolute/idle process deadlines.
                            let _ = tx.try_send(time_sec);
                        }
                        // Parse ffmpeg's live encoder stats (speed=/bitrate=/fps=)
                        // and forward them to the pipeline's stats channel so the
                        // UI can show a real-time render readout.  Using try_send
                        // avoids blocking the ffmpeg stderr reader when the stats
                        // consumer is slow; if the channel is full we log a warning
                        // once per ffmpeg invocation (throttled to avoid log spam).
                        if let Some(tx) = &tx_stats
                            && let Some(stats) = parse_stats(&line_cow)
                            && tx.try_send(stats).is_err()
                            && !stats_drop_warned
                        {
                            stats_drop_warned = true;
                            crate::utils::logger::log_line(
                                "WARNING: Render stats channel full — stats are being dropped. The UI may show stale render speed.",
                            );
                        }
                        // Only capture non-progress lines as potential error messages
                        let trimmed = line_cow.trim();
                        if !trimmed.is_empty() && extract_time(trimmed).is_none() {
                            last_stderr = trimmed.to_string();
                        }
                    }
                    Some(CommandEvent::Stdout(_)) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                    }
                    Some(CommandEvent::Error(err)) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
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
                        // Channel closed without a successful `Terminated` signal
                        // (e.g. the child was killed externally and the shell plugin
                        // dropped the receiver). Report this as a failure rather than
                        // a false success.
                        return Err(AppError::Ffmpeg(format!(
                            "FFmpeg process ended without a completion signal: {}",
                            last_stderr
                        )));
                    }
                }
            }
            _ = async {
                if let Some(control) = &cancel_control {
                    let mut cancel_rx = control.subscribe_cancel();
                    let mut pause_rx = control.subscribe_pause();
                    // Re-check AFTER subscribing: if cancel/pause was signaled
                    // between the top-of-loop check and the subscription above,
                    // `cancel_rx.changed()` won't detect it (fresh receivers
                    // start at the current version). We check the control one
                    // more time to ensure the signal is caught immediately.
                    if control.is_cancelled() || control.is_paused() {
                        return;
                    }
                    tokio::select! {
                        _ = async { cancel_rx.changed().await.ok() } => {}
                        _ = async { pause_rx.changed().await.ok() } => {}
                    }
                } else {
                    std::future::pending().await
                }
            } => {}
        }
    }
}

struct CapturedOutput {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Collects a sidecar's output with both an absolute deadline and an idle
/// deadline. The child is explicitly killed on every failure path so a timed
/// out probe cannot leave a background FFmpeg process behind.
async fn collect_output_with_timeout(
    mut rx: Receiver<CommandEvent>,
    child: CommandChild,
    timeout: std::time::Duration,
) -> Result<CapturedOutput, AppError> {
    let mut child_guard = ChildGuard(Some(child));
    let absolute_deadline = tokio::time::Instant::now() + timeout;
    let idle_timeout = std::time::Duration::from_secs(LOUDNORM_IDLE_TIMEOUT_SEC);
    let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut last_error = String::from("sidecar ended without a completion signal");

    let code = loop {
        tokio::select! {
            _ = tokio::time::sleep_until(absolute_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!(
                    "Sidecar process timed out ({}s limit)",
                    timeout.as_secs(),
                )));
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!(
                    "Sidecar process idle timeout ({}s limit)",
                    LOUDNORM_IDLE_TIMEOUT_SEC,
                )));
            }
            event_res = rx.recv() => {
                match event_res {
                    Some(CommandEvent::Stdout(bytes)) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                        stdout.extend(bytes);
                        stdout.push(b'\n');
                    }
                    Some(CommandEvent::Stderr(bytes)) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                        stderr.extend(bytes);
                        stderr.push(b'\n');
                    }
                    Some(CommandEvent::Error(error)) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                        last_error = error;
                    }
                    Some(CommandEvent::Terminated(payload)) => {
                        break payload.code;
                    }
                    Some(_) => {
                        idle_deadline = tokio::time::Instant::now() + idle_timeout;
                    }
                    None => {
                        child_guard.terminate();
                        return Err(AppError::Ffmpeg(last_error));
                    }
                }
            }
        }
    };

    let _ = child_guard.0.take();
    Ok(CapturedOutput {
        code,
        stdout,
        stderr,
    })
}

fn ensure_success(output: CapturedOutput, name: &str) -> Result<CapturedOutput, AppError> {
    if output.code == Some(0) {
        Ok(output)
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::Ffmpeg(format!(
            "{} exited with code {:?}: {}",
            name,
            output.code,
            if detail.is_empty() {
                "unknown error"
            } else {
                &detail
            },
        )))
    }
}

pub async fn get_video_info(app: &AppHandle, file_path: &Path) -> Result<VideoInfo, AppError> {
    let path = file_path.to_string_lossy().into_owned();
    let sidecar = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,r_frame_rate:format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &path,
        ]);
    let (rx, child) = sidecar
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let output = ensure_success(
        collect_output_with_timeout(rx, child, std::time::Duration::from_secs(PROBE_TIMEOUT_SEC))
            .await?,
        "ffprobe",
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();

    let codec = lines
        .next()
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());
    let frame_rate = lines
        .next()
        .and_then(|v| parse_ffprobe_frame_rate(v.trim()))
        .unwrap_or(30.0);
    let trimmed = lines.next().map(|l| l.trim()).unwrap_or("");
    let duration: f64 = trimmed.parse().map_err(|_| {
        AppError::Ffmpeg(format!(
            "Failed to parse duration from ffprobe: '{}'",
            trimmed
        ))
    })?;
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(path));
    }

    Ok(VideoInfo {
        duration,
        codec,
        frame_rate,
    })
}

pub async fn get_duration(app: &AppHandle, file_path: &Path) -> Result<f64, AppError> {
    // Standalone probe for duration only — works for audio-only files too.
    let path = file_path.to_string_lossy().into_owned();
    let sidecar = app
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
            &path,
        ]);
    let (rx, child) = sidecar
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let output = ensure_success(
        collect_output_with_timeout(rx, child, std::time::Duration::from_secs(PROBE_TIMEOUT_SEC))
            .await?,
        "ffprobe",
    )?;
    let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let duration: f64 = trimmed.parse().map_err(|_| {
        AppError::Ffmpeg(format!(
            "Failed to parse duration from ffprobe: '{}'",
            trimmed
        ))
    })?;
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(path));
    }
    Ok(duration)
}

/// Combined probe of audio-only metadata for the audio pool.
///
/// Calls `ffprobe` once and returns the first audio stream's codec, sample
/// rate, channel count, bit rate (if reported), and container duration in a
/// single round-trip. The audio pool uses this to decide whether to:
///   1. Smart-skip the re-encode (`-c copy`) when the source is already a
///      compatible AAC stream.
///   2. Apply two-pass loudnorm (otherwise).
///   3. Fall back to a plain single-pass re-encode.
///
/// `bit_rate` is intentionally optional because many AAC containers (notably
/// VBR .m4a) report `N/A` for that field — callers must treat `None` as
/// "cannot compare, default to re-encode".
pub async fn get_audio_info(app: &AppHandle, file_path: &Path) -> Result<AudioInfo, AppError> {
    let path_str = file_path.to_string_lossy().into_owned();
    let args = [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,bit_rate:format=duration",
        "-of",
        "json",
        &path_str,
    ];
    let sidecar = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(args);
    let (rx, child) = sidecar
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let output = ensure_success(
        collect_output_with_timeout(rx, child, std::time::Duration::from_secs(PROBE_TIMEOUT_SEC))
            .await?,
        "ffprobe",
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_audio_probe_value(&stdout, &path_str)
}

pub async fn run_loudnorm_pass1(
    app: &AppHandle,
    input: &Path,
    target: &str,
    cancel: Option<Arc<crate::RenderControl>>,
) -> Result<LoudnormMeasurement, AppError> {
    use tauri_plugin_shell::process::CommandEvent;

    if let Some(ref c) = cancel {
        c.ensure_running()?;
    }

    let input_str = input.to_string_lossy().into_owned();
    // The loudnorm filter syntax is `loudnorm=I=...:LRA=...:TP=...`; we
    // append `print_format=json` so ffmpeg writes the measurement JSON
    // instead of applying the target blindly.
    let filter = format!("loudnorm={}:print_format=json", target);
    let args: Vec<&str> = vec![
        "-hide_banner",
        "-i",
        &input_str,
        "-af",
        &filter,
        "-f",
        "null",
        "-",
    ];

    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let (mut rx, child) = sidecar
        .args(&args)
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let mut child_guard = ChildGuard(Some(child));

    // Accumulate the trailing JSON block from stderr. We resume collecting
    // when we see the opening `{` and stop once we have parsed a complete
    // measurement.
    let mut stderr_buf = String::new();
    let mut collecting = false;
    let mut last_problem = String::new();
    let absolute_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(DEFAULT_PROCESS_TIMEOUT_SEC);
    let idle_timeout = std::time::Duration::from_secs(LOUDNORM_IDLE_TIMEOUT_SEC);
    let mut idle_deadline = tokio::time::Instant::now() + idle_timeout;

    loop {
        if let Some(ref c) = cancel
            && let Err(e) = c.ensure_running()
        {
            child_guard.terminate();
            return Err(e);
        }

        tokio::select! {
            _ = tokio::time::sleep_until(absolute_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!(
                    "loudnorm pass1 timed out ({}s limit)",
                    DEFAULT_PROCESS_TIMEOUT_SEC,
                )));
            }
            _ = tokio::time::sleep_until(idle_deadline) => {
                child_guard.terminate();
                return Err(AppError::Ffmpeg(format!(
                    "loudnorm pass1 idle timeout ({}s limit)",
                    LOUDNORM_IDLE_TIMEOUT_SEC,
                )));
            }
            event_res = rx.recv() => match event_res {
            Some(CommandEvent::Stderr(line_bytes)) => {
                idle_deadline = tokio::time::Instant::now() + idle_timeout;
                let line = String::from_utf8_lossy(&line_bytes);
                let trimmed = line.trim();
                if !collecting && trimmed.starts_with('{') {
                    collecting = true;
                    stderr_buf.push_str(trimmed);
                    if trimmed.contains('}')
                        && let Some(m) = parse_loudnorm_measurement(&stderr_buf)
                    {
                        return Ok(m);
                    }
                } else if collecting {
                    stderr_buf.push_str(&line);
                    if line.contains('}')
                        && let Some(m) = parse_loudnorm_measurement(&stderr_buf)
                    {
                        return Ok(m);
                    }
                } else if !trimmed.is_empty() {
                    last_problem = trimmed.to_string();
                }
            }
            Some(CommandEvent::Terminated(payload)) => {
                if payload.code != Some(0) {
                    return Err(AppError::Ffmpeg(format!(
                        "loudnorm pass1 failed (exit {:?}): {}",
                        payload.code, last_problem
                    )));
                }
                if let Some(m) = parse_loudnorm_measurement(&stderr_buf) {
                    return Ok(m);
                }
                return Err(AppError::Ffmpeg(format!(
                    "loudnorm pass1 produced no JSON: {}",
                    last_problem
                )));
            }
            Some(CommandEvent::Error(e)) => {
                idle_deadline = tokio::time::Instant::now() + idle_timeout;
                last_problem = e;
            }
            Some(_) => {
                idle_deadline = tokio::time::Instant::now() + idle_timeout;
            }
            None => {
                return Err(AppError::Ffmpeg(format!(
                    "FFmpeg closed mid loudnorm pass1: {}",
                    last_problem
                )));
            }
        }
        }
    }
}

/// Parse the loudnorm JSON measurement block out of an arbitrary stderr
/// text.
///
/// We anchor on the leading literal `"input_i"` (the loudnorm `print_format=json`
/// output always emits the five required fields — `input_i`, `input_tp`,
/// `input_lra`, `input_thresh`, `target_offset` — in a flat object, and it is
/// the first one written). Scanning for the literal is robust against any
/// pre-amble noise in ffmpeg's stderr (warning text, decoder info, etc.) that
/// might contain unrelated `{…}` characters. Returns `None` if no complete
pub async fn verify_sidecar_binaries(app: &AppHandle) -> Result<(), AppError> {
    verify_version(app, "ffmpeg", "ffmpeg version ").await?;
    verify_version(app, "ffprobe", "ffprobe version ").await?;
    Ok(())
}

/// Parses the `major.minor` from an ffmpeg/ffprobe version banner line such as
/// `ffmpeg version 8.1.1-essentials_build-...` or `ffprobe version n8.2.0`.
///
async fn verify_version(app: &AppHandle, name: &str, prefix: &str) -> Result<(), AppError> {
    let sidecar_command = app
        .shell()
        .sidecar(name)
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(["-version"]);
    let (rx, child) = sidecar_command
        .spawn()
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let output = ensure_success(
        collect_output_with_timeout(rx, child, std::time::Duration::from_secs(PROBE_TIMEOUT_SEC))
            .await?,
        name,
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("");
    match parse_ffmpeg_version(first_line, prefix) {
        Some(version) if version_meets_minimum(version) => Ok(()),
        Some(_version) => {
            let (min_major, min_minor) = MIN_FFMPEG_VERSION;
            Err(AppError::Ffmpeg(format!(
                "Bundled {} binary is too old (requires at least {}.{}*, got '{}'). \
                 The binary may have been tampered with or is outdated.",
                name, min_major, min_minor, first_line
            )))
        }
        None => Err(AppError::Ffmpeg(format!(
            "Could not parse {} version from output: '{}'",
            name, first_line
        ))),
    }
}
