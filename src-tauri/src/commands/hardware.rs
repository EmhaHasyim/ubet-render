use serde::{Deserialize, Serialize};
use std::process::Command;
use sysinfo::System;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HardwareInfo {
    pub cpu_name: String,
    pub gpu_name: String,
    pub ram_gb: u64,
    pub av1_supported: bool,
}

#[tauri::command]
pub async fn detect_hardware() -> HardwareInfo {
    tokio::task::spawn_blocking(move || {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();

        let cpu_name = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "Tidak diketahui".to_string());

        let ram_gb = (sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)).round() as u64;

        let gpu_name = get_gpu_name();
        let av1_supported = check_av1_support();

        HardwareInfo {
            cpu_name,
            gpu_name,
            ram_gb,
            av1_supported,
        }
    })
    .await
    .unwrap_or_else(|_| HardwareInfo {
        cpu_name: "Tidak diketahui".to_string(),
        gpu_name: "Tidak diketahui".to_string(),
        ram_gb: 0,
        av1_supported: false,
    })
}

fn get_gpu_name() -> String {
    let mut ps_cmd = Command::new("powershell");
    ps_cmd.args([
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_VideoController).Name",
    ]);
    #[cfg(target_os = "windows")]
    ps_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = ps_cmd.output() {
        let names = parse_gpu_names(&String::from_utf8_lossy(&output.stdout));
        if !names.is_empty() {
            return names.join(", ");
        }
    }

    let mut wmic_cmd = Command::new("wmic");
    wmic_cmd.args(["path", "win32_VideoController", "get", "name"]);
    #[cfg(target_os = "windows")]
    wmic_cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = wmic_cmd.output() {
        let names: Vec<String> = parse_gpu_names(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .filter(|name| !name.eq_ignore_ascii_case("name"))
            .collect();
        if !names.is_empty() {
            return names.join(", ");
        }
    }

    "Tidak diketahui".to_string()
}

fn parse_gpu_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn check_av1_support() -> bool {
    let mut ffmpeg_cmd = Command::new("ffmpeg");
    ffmpeg_cmd.args(["-hide_banner", "-encoders"]);
    #[cfg(target_os = "windows")]
    ffmpeg_cmd.creation_flags(CREATE_NO_WINDOW);
    ffmpeg_cmd
        .output()
        .map(|out| {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("av1_nvenc") || stdout.contains("av1_amf") || stdout.contains("av1_qsv")
        })
        .unwrap_or(false)
}
