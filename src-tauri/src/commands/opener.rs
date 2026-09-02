use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Opens the OS file manager with `path` revealed / selected.
///
/// This mirrors the behaviour of Tauri's `opener` plugin `revealItemInDir`,
/// but is implemented with a self-contained OS command so we don't need to add
/// the plugin, its npm package, or a capability entry — keeping the
/// offline-first, minimal-dependency ethos.
///
/// - Windows: `explorer.exe /select,"<file>"` highlights a file, or
///   `explorer.exe "<dir>"` opens a directory.
/// - macOS: `open -R "<path>"` reveals the item in Finder.
/// - Linux: `xdg-open "<dir>"` opens the containing directory (there is no
///   reliable per-file "reveal" across desktop environments).
///
/// # Security
/// The path is restricted to the configured output directory and the temporary
/// thumbnails directory. This prevents a compromised frontend from using the
/// command to reveal arbitrary system files.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    // Reject traversal, control characters, and other dangerous path forms
    // before touching the filesystem.
    let _ = crate::validation::sanitize_path(&path).map_err(|e| e.to_string())?;
    let p = Path::new(&path);

    let config = crate::config::AppConfig::load();
    if config.directories.output.trim().is_empty() {
        return Err("Output directory is not configured".into());
    }
    let output_dir = crate::utils::fs::to_absolute(Path::new(&config.directories.output));
    if crate::validation::is_system_protected_path(&output_dir) {
        return Err(format!(
            "Output directory is a system-protected location and cannot be used: {}",
            config.directories.output
        ));
    }

    let thumb_dir = crate::utils::fs::ubet_temp_dir().join("thumbnails");
    // Canonicalize roots for consistent path comparison.  When
    // canonicalize fails (e.g. the directory doesn't exist yet),
    // fall back to validating the path with sanitize_path first,
    // then use the absolute form so symlink traversal through the
    // unresolved path is still caught by resolve_and_validate_path.
    let output_root = output_dir
        .canonicalize()
        .unwrap_or_else(|_| crate::utils::fs::to_absolute(&output_dir));
    let thumb_root = thumb_dir
        .canonicalize()
        .unwrap_or_else(|_| crate::utils::fs::to_absolute(&thumb_dir));
    let allowed_roots: Vec<PathBuf> = vec![output_root, thumb_root];

    let _ = crate::validation::resolve_and_validate_path(p, &allowed_roots)
        .map_err(|e| format!("Path not allowed to open: {} ({})", path, e))?;

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        let status = if p.is_dir() {
            command.arg(p).spawn()
        } else {
            // `/select,` must be a single argument with the quoted path.
            // Rust `\"` inside a string literal produces a literal `"` character.
            let arg = format!("/select,\"{}\"", path);
            command.arg(&arg).spawn()
        };
        status
            .map(|_| ())
            .map_err(|e| format!("Failed to open File Explorer: {}", e))
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open Finder: {}", e))
    }

    #[cfg(target_os = "linux")]
    {
        let open_path = if p.is_dir() {
            path.clone()
        } else {
            p.parent()
                .map(|parent| parent.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(open_path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open file manager: {}", e))
    }
}
