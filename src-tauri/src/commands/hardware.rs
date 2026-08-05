use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::OnceLock;
use sysinfo::System;
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu_name: String,
    pub gpu_name: String,
    pub ram_gb: u64,
    pub av1_supported: bool,
}

#[tauri::command]
pub async fn detect_hardware(app: tauri::AppHandle) -> HardwareInfo {
    let (cpu_name, ram_gb, gpu_name) = tokio::task::spawn_blocking(move || {
        let mut sys = System::new_all();
        sys.refresh_cpu_all();
        sys.refresh_memory();

        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let ram_gb = (sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)).round() as u64;

        let gpu_name = get_gpu_name();
        (cpu_name, ram_gb, gpu_name)
    })
    .await
    .unwrap_or_else(|_| (
        "Unknown".to_string(),
        0,
        "Unknown".to_string(),
    ));

    let av1_supported = check_av1_support(&app).await;

    HardwareInfo {
        cpu_name,
        gpu_name,
        ram_gb,
        av1_supported,
    }
}

fn get_gpu_name() -> String {
    // ── Windows: PowerShell + WMIC fallback ───────────────────────────
    #[cfg(target_os = "windows")]
    {
        let mut ps_cmd = Command::new("powershell");
        ps_cmd.args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_VideoController).Name",
        ]);
        ps_cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = ps_cmd.output() {
            let names = parse_gpu_names(&String::from_utf8_lossy(&output.stdout));
            if !names.is_empty() {
                return names.join(", ");
            }
        }

        let mut wmic_cmd = Command::new("wmic");
        wmic_cmd.args(["path", "win32_VideoController", "get", "name"]);
        wmic_cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = wmic_cmd.output() {
            let names: Vec<String> =
                parse_gpu_names(&String::from_utf8_lossy(&output.stdout))
                    .into_iter()
                    .filter(|name| !name.eq_ignore_ascii_case("name"))
                    .collect();
            if !names.is_empty() {
                return names.join(", ");
            }
        }
    }

    // ── macOS: system_profiler ────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("system_profiler")
            .args(["SPDisplaysDataType"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Extract lines like "Chipset Model: Apple M1 Pro"
            let gpus: Vec<String> = stdout
                .lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    trimmed
                        .strip_prefix("Chipset Model: ")
                        .or_else(|| trimmed.strip_prefix("Chipset Model:"))
                        .map(str::to_string)
                })
                .collect();
            if !gpus.is_empty() {
                return gpus.join(", ");
            }
        }
    }

    // ── Linux: lspci ──────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("lspci").args(["-mm"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let gpus: Vec<String> = stdout
                .lines()
                .filter(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("vga") || lower.contains("3d") || lower.contains("display")
                })
                .filter_map(|line| {
                    // "-mm" machine-readable: double-quoted fields.
                    // rsplit('"') yields ["", last_field, " ", ..., first_field, ""];
                    // nth(1) picks the last substantive field (the device name).
                    line.rsplit('"').nth(1).map(|s| s.trim().to_string())
                })
                .collect();
            if !gpus.is_empty() {
                return gpus.join(", ");
            }
        }
    }

    "Unknown".to_string()
}

// Only called on Windows (cfg-gated inside get_gpu_name).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_gpu_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// Cached verdict so the (potentially slow) AV1 probe runs at most once per
/// app session. Without a cache, every remount (e.g. ErrorBoundary "Try
/// Again") would re-run up to four ffmpeg subprocesses and could stall
/// rendering startup for tens of seconds.
static AV1_SUPPORT_CACHE: OnceLock<bool> = OnceLock::new();

async fn check_av1_support(app: &tauri::AppHandle) -> bool {
    if let Some(v) = AV1_SUPPORT_CACHE.get() {
        return *v;
    }
    let probe_timeout = std::time::Duration::from_secs(8);

    // Probe the three vendor hardware encoders CONCURRENTLY and run the
    // software (libsvtav1) scan in parallel too. The previous sequential
    // loop could stall app startup for up to 3× the probe timeout (24 s)
    // plus the fallback scan (8 s) on a machine where an encoder exists
    // but initialises slowly. Parallelising bounds the worst case to a
    // single probe timeout while keeping the accuracy of actually testing
    // each encoder.
    let hw_fut = futures::future::join_all(
        ["av1_nvenc", "av1_amf", "av1_qsv"]
            .iter()
            .map(|&encoder| probe_hw_encoder(app, encoder, probe_timeout)),
    );
    let svt_fut = scan_encoders_for_svt_av1(app, probe_timeout);
    let (hw_results, has_svt) = tokio::join!(hw_fut, svt_fut);

    let supported = hw_results.into_iter().any(|r| r) || has_svt;
    let _ = AV1_SUPPORT_CACHE.set(supported);
    supported
}

/// Run one ffmpeg hardware-encode probe. Returns `true` when the encoder
/// produced a frame successfully within `probe_timeout`.
async fn probe_hw_encoder(
    app: &tauri::AppHandle,
    encoder: &str,
    probe_timeout: std::time::Duration,
) -> bool {
    let Ok(sidecar_command) = app.shell().sidecar("ffmpeg") else {
        return false;
    };
    let sidecar_command = sidecar_command.args([
        "-v", "error",
        "-f", "lavfi",
        "-i", "color=c=black:s=256x256",
        "-vframes", "1",
        "-c:v", encoder,
        "-f", "null",
        "-",
    ]);
    matches!(
        tokio::time::timeout(probe_timeout, sidecar_command.output()).await,
        Ok(Ok(output)) if output.status.success()
    )
}

/// Cheap fallback: check whether the bundled ffmpeg lists `libsvtav1`
/// among its compiled encoders.
async fn scan_encoders_for_svt_av1(
    app: &tauri::AppHandle,
    probe_timeout: std::time::Duration,
) -> bool {
    let Ok(sidecar_command) = app.shell().sidecar("ffmpeg") else {
        return false;
    };
    let sidecar_command = sidecar_command.args(["-hide_banner", "-encoders"]);
    match tokio::time::timeout(probe_timeout, sidecar_command.output()).await {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("libsvtav1")
        }
        _ => false,
    }
}
