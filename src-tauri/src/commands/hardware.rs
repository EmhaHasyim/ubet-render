use serde::{Deserialize, Serialize};
use std::process::Command;
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
            .unwrap_or_else(|| "Tidak diketahui".to_string());

        let ram_gb = (sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)).round() as u64;

        let gpu_name = get_gpu_name();
        (cpu_name, ram_gb, gpu_name)
    })
    .await
    .unwrap_or_else(|_| (
        "Tidak diketahui".to_string(),
        0,
        "Tidak diketahui".to_string(),
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

async fn check_av1_support(app: &tauri::AppHandle) -> bool {
    let hw_encoders = ["av1_nvenc", "av1_amf", "av1_qsv"];
    
    for encoder in hw_encoders {
        let Ok(sidecar_command) = app.shell().sidecar("ffmpeg") else {
            continue;
        };
        let sidecar_command = sidecar_command.args([
                "-v", "error",
                "-f", "lavfi",
                "-i", "color=c=black:s=256x256",
                "-vframes", "1",
                "-c:v", encoder,
                "-f", "null",
                "-"
            ]);
        
        if let Ok(output) = sidecar_command.output().await && output.status.success() {
            return true;
        }
    }

    let Ok(sidecar_command) = app.shell().sidecar("ffmpeg") else {
        return false;
    };
    let sidecar_command = sidecar_command.args(["-hide_banner", "-encoders"]);
        
    sidecar_command
        .output()
        .await
        .map(|out| {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.contains("libsvtav1")
        })
        .unwrap_or(false)
}
