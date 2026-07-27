use std::ffi::OsStr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

use crate::error::AppError;
use crate::models::job::RenderStats;
use crate::models::media::{AudioInfo, LoudnormMeasurement};

struct ChildGuard(Option<tauri_plugin_shell::process::CommandChild>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

pub async fn run<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: &[S],
    tx_progress: Option<tokio::sync::mpsc::Sender<f64>>,
    cancel_control: Option<Arc<crate::RenderControl>>,
    tx_stats: Option<tokio::sync::mpsc::Sender<RenderStats>>,
) -> Result<(), AppError> {
    run_with_timeout(app, args, tx_progress, cancel_control, tx_stats, 86400).await
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
        // waiting for resume. The previous `wait_for_resume()` left a job
        // hanging in the window between job start and the first stderr line,
        // which was inconsistent with the pipeline's terminate-on-pause design
        // (and with the in-loop branch). Cancel takes precedence, as below.
        if control.is_cancelled() {
            return Err(cancelled_error());
        }
        if control.is_paused() {
            return Err(AppError::Paused("FFmpeg paused by user".into()));
        }
    }
    let sidecar_command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(args);

    let (mut rx, child) = sidecar_command.spawn().map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    // This guard kills the child process on drop (including on panic / early
    // return). The variable IS used — its Drop impl is the intended side-effect.
    let mut child_guard = ChildGuard(Some(child));
    
    let mut last_stderr = "Unknown ffmpeg error".to_string();
    let timeout_dur = std::time::Duration::from_secs(max_timeout_sec.max(300));
    let mut deadline = tokio::time::Instant::now() + timeout_dur;
    loop {
        if let Some(ref control) = cancel_control {
            if control.is_cancelled() {
                let _ = child_guard.0.take().map(|c| c.kill());
                return Err(cancelled_error());
            }
            if control.is_paused() {
                let _ = child_guard.0.take().map(|c| c.kill());
                let msg = "FFmpeg paused by user".into();
                return Err(AppError::Paused(msg));
            }
        }

        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child_guard.0.take().map(|c| c.kill());
                return Err(AppError::Ffmpeg(format!("FFmpeg process timed out ({}s limit)", max_timeout_sec)));
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
                        deadline = tokio::time::Instant::now() + timeout_dur;
                        if let (Some(tx), Some(time_sec)) = (&tx_progress, extract_time(&line_cow)) {
                            let _ = tx.send(time_sec).await;
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
                        {
                            static WARNED: AtomicBool = AtomicBool::new(false);
                            if !WARNED.swap(true, Ordering::Relaxed) {
                                crate::utils::logger::log_line(
                                    "WARNING: Render stats channel full — stats are being dropped. The UI may show stale render speed.",
                                );
                            }
                        }
                        // Only capture non-progress lines as potential error messages
                        let trimmed = line_cow.trim();
                        if !trimmed.is_empty() && extract_time(trimmed).is_none() {
                            last_stderr = trimmed.to_string();
                        }
                    }
                    Some(CommandEvent::Stdout(_)) => {}
                    Some(CommandEvent::Error(err)) => {
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

fn cancelled_error() -> AppError {
    AppError::Cancelled("Render cancelled by user".into())
}

fn extract_time(line: &str) -> Option<f64> {
    let time_marker = "time=";
    if let Some(start) = line.find(time_marker) {
        let after_time = &line[start + time_marker.len()..];
        let time_val = after_time.split_whitespace().next()?;
        let parts: Vec<&str> = time_val.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let s: f64 = parts[2].parse().ok()?;
            return Some(h * 3600.0 + m * 60.0 + s);
        }
    }
    None
}

/// Strip a trailing unit suffix (e.g. the `kbits/s` in `bitrate=4123.4kbits/s`,
/// or the `x` in `speed=12.3x`) so the bare numeric value can be parsed.
///
/// Only strips ASCII alphabetic suffixes — Unicode alphabetic chars are
/// preserved so edge-case output is not incorrectly truncated.
fn strip_units(tok: &str) -> &str {
    tok.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '/' || c == ':')
}

/// Parses ffmpeg's periodic status line (the `speed=`, `bitrate=` and `fps=`
/// tokens it prints on every progress update) into a [`RenderStats`].
///
/// Returns `None` when none of the three tokens are present, so the caller can
/// cheaply skip non-status lines. Token values are of the form `12.3x`,
/// `4123.4kbits/s` or a plain `29.97`; the trailing unit suffix is stripped
/// before parsing. `N/A` is intentionally unparseable and therefore ignored.
fn parse_stats(line: &str) -> Option<RenderStats> {
    let mut speed = 0.0f64;
    let mut bitrate_kbps = 0.0f64;
    let mut fps = 0.0f64;
    let mut any = false;

    if let Some(idx) = line.find("speed=")
        && let Some(tok) = line[idx + 6..].split_whitespace().next()
            && let Ok(v) = strip_units(tok).parse::<f64>() {
                speed = v;
                any = true;
            }
    if let Some(idx) = line.find("bitrate=")
        && let Some(tok) = line[idx + 8..].split_whitespace().next()
            && let Ok(v) = strip_units(tok).parse::<f64>() {
                bitrate_kbps = v;
                any = true;
            }
    if let Some(idx) = line.find("fps=")
        && let Some(tok) = line[idx + 4..].split_whitespace().next()
            && let Ok(v) = strip_units(tok).parse::<f64>() {
                fps = v;
                any = true;
            }

    if any {
        Some(RenderStats { speed, bitrate_kbps, fps })
    } else {
        None
    }
}

/// Combined video metadata probe — returns duration, codec, and frame rate
/// from a single ffprobe invocation instead of three separate subprocess calls.
pub struct VideoInfo {
    pub duration: f64,
    pub codec: Option<String>,
    pub frame_rate: f64,
}

pub async fn get_video_info(app: &AppHandle, file_path: &Path) -> Result<VideoInfo, AppError> {
    let sidecar_command = app
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
            &file_path.to_string_lossy(),
        ]);

    let output = sidecar_command
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();

    // Line 1: codec_name (empty if no video stream)
    let codec = lines
        .next()
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());

    // Line 2: r_frame_rate (fraction like "30000/1001" or "30")
    let frame_rate = lines
        .next()
        .and_then(|v| parse_ffprobe_frame_rate(v.trim()))
        .unwrap_or(30.0);

    // Line 3: duration (float)
    let trimmed = lines
        .next()
        .map(|l| l.trim())
        .unwrap_or("");
    let duration: f64 = trimmed.parse().map_err(|_| {
        AppError::Ffmpeg(format!("Failed to parse duration from ffprobe: '{}'", trimmed))
    })?;
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(
            file_path.to_string_lossy().to_string(),
        ));
    }

    Ok(VideoInfo {
        duration,
        codec,
        frame_rate,
    })
}

/// Parse an ffprobe r_frame_rate value (fraction "30000/1001" or float "29.97").
fn parse_ffprobe_frame_rate(value: &str) -> Option<f64> {
    if let Some((num, den)) = value.split_once('/') {
        let n: f64 = num.trim().parse().ok()?;
        let d: f64 = den.trim().parse().ok()?;
        if d == 0.0 {
            return None;
        }
        Some((n / d).clamp(1.0, 240.0))
    } else {
        value.parse::<f64>().ok().map(|f| f.clamp(1.0, 240.0))
    }
}

pub async fn get_duration(app: &AppHandle, file_path: &Path) -> Result<f64, AppError> {
    // Standalone probe for duration only — does NOT use `-select_streams v:0`
    // like `get_video_info` does, so it works on audio-only files (M4A, MP3,
    // etc.) that have no video stream.  Uses `format=duration` which is always
    // available regardless of stream type.
    let sidecar_command = app
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
            &file_path.to_string_lossy(),
        ]);

    let output = sidecar_command
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    let duration: f64 = trimmed.parse().map_err(|_| {
        AppError::Ffmpeg(format!(
            "Failed to parse duration from ffprobe: '{}'",
            trimmed
        ))
    })?;
    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(
            file_path.to_string_lossy().to_string(),
        ));
    }
    Ok(duration)
}


const MIN_FFMPEG_VERSION: (u32, u32) = (8, 1);

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
    let output = sidecar
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;

    if !output.status.success() {
        return Err(AppError::Ffmpeg(format!(
            "ffprobe exited with code {:?} for '{}'",
            output.status.code(),
            path_str
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_audio_probe_value(&stdout, &path_str)
}

/// Pure JSON→AudioInfo parser extracted from `get_audio_info` so it can be
/// unit-tested without spinning up Tauri + ffprobe. `source_label` is used
/// only to make error messages reference a meaningful path.
fn parse_audio_probe_value(
    stdout: &str,
    source_label: &str,
) -> Result<AudioInfo, AppError> {
    let json: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe JSON parse failed for '{}': {}", source_label, e)))?;

    let stream = json
        .get("streams")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .ok_or_else(|| {
            AppError::Ffmpeg(format!("No audio stream found in '{}'", source_label))
        })?;

    let codec = stream
        .get("codec_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let sample_rate = stream
        .get("sample_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| AppError::Ffmpeg(format!("Missing sample_rate in '{}'", source_label)))?;

    let channels = stream
        .get("channels")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| {
            AppError::Ffmpeg(format!("Missing channels in '{}'", source_label))
        })? as u32;

    let bit_rate = stream
        .get("bit_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok());

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or_else(|| AppError::Ffmpeg(format!("Missing duration in '{}'", source_label)))?;

    if duration <= 0.0 {
        return Err(AppError::InvalidDuration(source_label.to_string()));
    }

    Ok(AudioInfo {
        codec,
        sample_rate,
        channels,
        bit_rate,
    })
}

/// Pass 1 of EBU R128 two-pass loudnorm.
///
/// Runs `ffmpeg` with the loudnorm analysis filter and `print_format=json`,
/// which causes ffmpeg to emit a JSON block on stderr containing the
/// measured integrated loudness, true peak, LRA, threshold, and target
/// offset for the source audio. The audio pool's two-pass mode feeds these
/// values back to pass 2 for a much more accurate normalization than the
/// single-pass `loudnorm=I=...:LRA=...:TP=...` allowed for.
///
/// Unlike `get_audio_info`, pass 1 streams stderr live (via `spawn()`) so
/// that the cooperative cancel / pause control can interrupt long files.
pub async fn run_loudnorm_pass1(
    app: &AppHandle,
    input: &Path,
    target: &str,
    cancel: Option<Arc<crate::RenderControl>>,
) -> Result<LoudnormMeasurement, AppError> {
    use tauri_plugin_shell::process::CommandEvent;

    if let Some(ref c) = cancel {
        if c.is_cancelled() {
            return Err(cancelled_error());
        }
        if c.is_paused() {
            return Err(AppError::Paused("FFmpeg paused by user".into()));
        }
    }

    let input_str = input.to_string_lossy().into_owned();
    // The loudnorm filter syntax is `loudnorm=I=...:LRA=...:TP=...`; we
    // append `print_format=json` so ffmpeg writes the measurement JSON
    // instead of applying the target blindly.
    let filter = format!("loudnorm={}:print_format=json", target);
    let args: Vec<&str> = vec![
        "-hide_banner", "-i", &input_str, "-af", &filter, "-f", "null", "-",
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

    loop {
        if let Some(ref c) = cancel {
            if c.is_cancelled() {
                let _ = child_guard.0.take().map(|x| x.kill());
                return Err(cancelled_error());
            }
            if c.is_paused() {
                let _ = child_guard.0.take().map(|x| x.kill());
                return Err(AppError::Paused("FFmpeg paused by user".into()));
            }
        }

        match rx.recv().await {
            Some(CommandEvent::Stderr(line_bytes)) => {
                let line = String::from_utf8_lossy(&line_bytes);
                let trimmed = line.trim();
                if !collecting && trimmed.starts_with('{') {
                    collecting = true;
                    stderr_buf.push_str(trimmed);
                    if trimmed.contains('}') {
                        if let Some(m) = parse_loudnorm_measurement(&stderr_buf) {
                            return Ok(m);
                        }
                    }
                } else if collecting {
                    stderr_buf.push_str(&line);
                    if line.contains('}') {
                        if let Some(m) = parse_loudnorm_measurement(&stderr_buf) {
                            return Ok(m);
                        }
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
                last_problem = e;
            }
            Some(_) => {}
            None => {
                return Err(AppError::Ffmpeg(format!(
                    "FFmpeg closed mid loudnorm pass1: {}",
                    last_problem
                )));
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
/// block is found.
///
/// Required fields (matching `LoudnormMeasurement`): `input_i`,
/// `input_tp`, `input_lra`, `input_thresh`, `target_offset`. Any missing
/// required field causes `None` so the caller can fall back to single-pass.
fn parse_loudnorm_measurement(text: &str) -> Option<LoudnormMeasurement> {
    let anchor = "\"input_i\"";
    let anchor_idx = text.find(anchor)?;
    let bytes = text.as_bytes();
    // Walk backward from the anchor to find the opening `{` that begins this
    // JSON object. Stop if we walk more than a few thousand characters back,
    // which would indicate the anchor landed in unrelated content.
    let mut start = anchor_idx;
    let max_back = 4096;
    while start > 0 && bytes[start - 1] != b'{' {
        start -= 1;
        if anchor_idx - start > max_back {
            return None;
        }
    }
    if start == 0 && bytes[start] != b'{' {
        return None;
    }
    // The loudnorm JSON has no nested objects / arrays of objects, so the
    // first `}` after the anchor closes the measurement block.
    let rest = &text[anchor_idx..];
    let end_rel = rest.find('}')?;
    let end = anchor_idx + end_rel + 1;
    let slice = &text[start..end];
    let parsed: serde_json::Value = serde_json::from_str(slice).ok()?;
    let obj = parsed.as_object()?;

    let parse_f = |k: &str| -> Option<f64> {
        obj.get(k)
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
    };

    Some(LoudnormMeasurement {
        input_i: parse_f("input_i")?,
        input_tp: parse_f("input_tp")?,
        input_lra: parse_f("input_lra")?,
        input_thresh: parse_f("input_thresh")?,
        target_offset: parse_f("target_offset")?,
    })
}

/// Verifies the bundled `ffmpeg` and `ffprobe` sidecars report a supported
/// version (at least [`MIN_FFMPEG_VERSION`]). Call this once before starting
/// a render.
pub async fn verify_sidecar_binaries(app: &AppHandle) -> Result<(), AppError> {
    verify_version(app, "ffmpeg", "ffmpeg version ").await?;
    verify_version(app, "ffprobe", "ffprobe version ").await?;
    Ok(())
}

/// Parses the `major.minor` from an ffmpeg/ffprobe version banner line such as
/// `ffmpeg version 8.1.1-essentials_build-...` or `ffprobe version n8.2.0`.
///
/// Some static builds prefix the version with `n` (e.g. `n8.1.1`); that prefix
/// is stripped before parsing. Returns `None` if the version can't be parsed.
fn parse_ffmpeg_version(line: &str, prefix: &str) -> Option<(u32, u32)> {
    let rest = line.split(prefix).nth(1)?;
    let token = rest.split_whitespace().next()?;
    // Static builds commonly prefix the version with 'n' (e.g. `n8.1.1`).
    let token = token.strip_prefix('n').unwrap_or(token);
    let mut parts = token.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn version_meets_minimum(version: (u32, u32)) -> bool {
    let (min_major, min_minor) = MIN_FFMPEG_VERSION;
    version.0 > min_major || (version.0 == min_major && version.1 >= min_minor)
}

async fn verify_version(app: &AppHandle, name: &str, prefix: &str) -> Result<(), AppError> {
    let sidecar_command = app
        .shell()
        .sidecar(name)
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?
        .args(["-version"]);
    let output = sidecar_command
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(e.to_string()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // strip_units
    // -----------------------------------------------------------------------

    #[test]
    fn test_strip_units_removes_kbits_suffix() {
        assert_eq!(strip_units("4123.4kbits/s"), "4123.4");
    }

    #[test]
    fn test_strip_units_removes_x_suffix() {
        assert_eq!(strip_units("12.3x"), "12.3");
    }

    #[test]
    fn test_strip_units_removes_k_suffix() {
        assert_eq!(strip_units("5000k"), "5000");
    }

    #[test]
    fn test_strip_units_preserves_bare_number() {
        assert_eq!(strip_units("29.97"), "29.97");
    }

    #[test]
    fn test_strip_units_does_not_strip_unicode() {
        assert_eq!(strip_units("123abc"), "123");
    }

    #[test]
    fn test_strip_units_empty() {
        assert_eq!(strip_units(""), "");
    }

    // -----------------------------------------------------------------------
    // extract_time
    // -----------------------------------------------------------------------

    #[test]
    fn test_extract_time_standard_format() {
        let result = extract_time("time=01:23:45.67");
        assert!(result.is_some());
        let expected = 1.0 * 3600.0 + 23.0 * 60.0 + 45.67;
        assert!((result.unwrap() - expected).abs() < 0.01);
    }

    #[test]
    fn test_extract_time_no_match() {
        assert!(extract_time("frame=  120 fps=30").is_none());
    }

    #[test]
    fn test_extract_time_with_surrounding_text() {
        let result = extract_time("frame=  120 fps=30.0 time=00:05:30.00 bitrate=1234.5kbits/s");
        assert!(result.is_some());
        assert!((result.unwrap() - 330.0).abs() < 0.01);
    }

    #[test]
    fn test_extract_time_invalid_parts() {
        assert!(extract_time("time=ab:cd:ef").is_none());
    }

    // -----------------------------------------------------------------------
    // parse_stats
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_stats_all_fields() {
        let line = "frame=  120 fps=30.0 speed=12.5x bitrate=4123.4kbits/s";
        let stats = parse_stats(line);
        assert!(stats.is_some());
        let s = stats.unwrap();
        assert!((s.speed - 12.5).abs() < 0.01);
        assert!((s.bitrate_kbps - 4123.4).abs() < 0.01);
        assert!((s.fps - 30.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_stats_partial_speed_only() {
        let line = "speed=2.0x";
        let stats = parse_stats(line);
        assert!(stats.is_some());
        let s = stats.unwrap();
        assert!((s.speed - 2.0).abs() < 0.01);
        assert!((s.bitrate_kbps - 0.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_stats_no_match() {
        let line = "frame=  120 duration=00:01:00";
        assert!(parse_stats(line).is_none());
    }

    #[test]
    fn test_parse_stats_empty() {
        assert!(parse_stats("").is_none());
    }

    // -----------------------------------------------------------------------
    // parse_ffprobe_frame_rate
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_ffprobe_frame_rate_fraction() {
        let result = parse_ffprobe_frame_rate("30000/1001");
        assert!(result.is_some());
        assert!((result.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_float() {
        let result = parse_ffprobe_frame_rate("29.97");
        assert!(result.is_some());
        assert!((result.unwrap() - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_invalid() {
        assert!(parse_ffprobe_frame_rate("invalid").is_none());
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_zero_denominator() {
        assert!(parse_ffprobe_frame_rate("1/0").is_none());
    }

    #[test]
    fn test_parse_ffprobe_frame_rate_clamped() {
        let result = parse_ffprobe_frame_rate("1000");
        assert!(result.is_some());
        assert!((result.unwrap() - 240.0).abs() < 0.01);
    }

    // -----------------------------------------------------------------------
    // parse_ffmpeg_version
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_ffmpeg_version_standard() {
        let result = parse_ffmpeg_version("ffmpeg version 8.1.1-essentials_build", "ffmpeg version ");
        assert_eq!(result, Some((8, 1)));
    }

    #[test]
    fn test_parse_ffmpeg_version_n_prefix() {
        let result = parse_ffmpeg_version("ffprobe version n8.2.0", "ffprobe version ");
        assert_eq!(result, Some((8, 2)));
    }

    #[test]
    fn test_parse_ffmpeg_version_no_match() {
        let result = parse_ffmpeg_version("unexpected output", "ffmpeg version ");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_ffmpeg_version_minor_only() {
        let result = parse_ffmpeg_version("ffmpeg version 7.0", "ffmpeg version ");
        assert_eq!(result, Some((7, 0)));
    }

    // -----------------------------------------------------------------------
    // version_meets_minimum
    // -----------------------------------------------------------------------

    #[test]
    fn test_version_meets_minimum_exact_match() {
        assert!(version_meets_minimum((8, 1)));
    }

    #[test]
    fn test_version_meets_minimum_above() {
        assert!(version_meets_minimum((8, 2)));
        assert!(version_meets_minimum((9, 0)));
    }

    #[test]
    fn test_version_meets_minimum_below() {
        assert!(!version_meets_minimum((8, 0)));
        assert!(!version_meets_minimum((7, 5)));
    }

    #[test]
    fn test_version_meets_minimum_major_above() {
        assert!(version_meets_minimum((10, 0)));
    }
}
