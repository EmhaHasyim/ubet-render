//! Platform process helpers shared by the `FFmpeg`, GPU-probe and file-manager
//! integrations. Keeping Windows system paths in one place prevents a PATH
//! hijack from redirecting any child process and avoids repeated copies of the
//! same `SystemRoot` fallback.

#[cfg(windows)]
use std::path::PathBuf;

/// `CREATE_NO_WINDOW` process creation flag (Windows).
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows installation root (`%SystemRoot%`), falling back to the
/// conventional `C:\Windows` when the variable is missing.
#[cfg(windows)]
pub fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// `%SystemRoot%\System32`, where `taskkill`, PowerShell and WMIC live.
#[cfg(windows)]
pub fn system32_dir() -> PathBuf {
    system_root().join("System32")
}
