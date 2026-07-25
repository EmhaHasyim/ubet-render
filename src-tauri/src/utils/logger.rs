use std::io::{LineWriter, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Lazily-initialised persistent log writer. The file is opened once during
/// [`init_logger`] and held open for the lifetime of the process. Every
/// [`log_line`] call writes to the same buffered writer, avoiding the
/// open/seek/close syscall overhead of the previous per-call open approach.
static LOG_WRITER: OnceLock<Mutex<LineWriter<std::fs::File>>> = OnceLock::new();

/// Path to the current render log file. Set once by [`init_logger`].
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Initializes the file logger. Creates a log file under
/// `{TEMP}/ubet-render/logs/render_YYYYMMDD_HHMMSS.log`.
///
/// Call this once during app setup, before any render starts. Idempotent:
/// subsequent calls are no-ops.
pub fn init_logger() {
    if LOG_WRITER.get().is_some() {
        return;
    }
    let log_dir = crate::utils::fs::ubet_temp_dir()
        .join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join(format!(
        "render_{}.log",
        chrono::Utc::now().format("%Y%m%d_%H%M%S")
    ));

    // Open the file once and wrap it in a LineWriter so every write is
    // line-buffered — data is flushed to disk on every newline without the
    // overhead of open/close syscalls per call.
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let writer = LineWriter::new(file);
        let _ = LOG_PATH.set(log_path);
        let _ = LOG_WRITER.set(Mutex::new(writer));

        // Write an opening marker so the file is never empty
        log_line(&format!(
            "=== Ubet Render log started at {} ===",
            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
        ));
    }
}

/// Writes a single line to the current log file. Lines are timestamped.
/// If the logger hasn't been initialized, the call is silently ignored.
pub fn log_line(message: &str) {
    let Some(writer) = LOG_WRITER.get() else {
        return;
    };
    if let Ok(mut guard) = writer.lock() {
        let _ = writeln!(
            guard,
            "[{}] {}",
            chrono::Utc::now().format("%H:%M:%S%.3f"),
            message
        );
        // LineWriter already flushes on newline; the explicit flush here
        // ensures the write survives even on an unclean shutdown.
        let _ = guard.flush();
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logger_init_creates_file() {
        // Reset for test — only works because tests run single-threaded
        // by default. In practice `init_logger` is a one-shot.
        init_logger();
        let path = LOG_PATH.get();
        assert!(path.is_some(), "LOG_PATH should be set after init");
        assert!(
            path.unwrap().exists(),
            "log file should exist on disk"
        );
        // Clean up so subsequent tests don't interfere
        let _ = std::fs::remove_file(path.unwrap());
    }

    #[test]
    fn test_log_line_after_init() {
        init_logger();
        log_line("test message");
        let path = LOG_PATH.get().unwrap();
        let content = std::fs::read_to_string(path).unwrap_or_default();
        assert!(content.contains("test message"), "log file should contain the written line");
        let _ = std::fs::remove_file(path);
    }
}
