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

/// How long (in days) per-session `render_*.log` files are kept before they
/// are pruned. A new log file is created on every launch, so without this
/// the temp log directory would grow unboundedly across sessions.
const LOG_RETENTION_DAYS: u64 = 7;

/// Removes `render_YYYYMMDD_HHMMSS.log` files older than `retention_days`.
/// The age is derived from the timestamp embedded in the filename (created
/// by [`init_logger`]), which keeps the function deterministic and easily
/// testable without touching file mtimes. Files that don't match the
/// `render_*.log` naming pattern are left untouched.
fn prune_old_logs(log_dir: &std::path::Path, retention_days: u64) {
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return;
    };
    let today = chrono::Utc::now().date_naive();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stamp) = name
            .strip_prefix("render_")
            .and_then(|rest| rest.strip_suffix(".log"))
        else {
            continue;
        };
        let Ok(dt) = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S") else {
            continue;
        };
        // Compare exact day deltas so the cutoff is precisely `retention_days`
        // (num_days() truncates and would keep files up to ~8 days old).
        let cutoff = chrono::Duration::days(retention_days as i64);
        if today.signed_duration_since(dt.date()) >= cutoff {
            let _ = std::fs::remove_file(&path);
        }
    }
}

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
    // Keep the log directory from growing forever across sessions.
    prune_old_logs(&log_dir, LOG_RETENTION_DAYS);
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
    fn test_logger_init_creates_file_and_writes() {
        // `init_logger` is a one-shot (OnceLock): this single test owns the
        // global LOG_PATH, so no parallel test can race on the shared file
        // (two separate tests both asserting/removing it were flaky under
        // parallel execution).
        init_logger();
        let path = LOG_PATH.get().expect("LOG_PATH should be set after init");
        assert!(path.exists(), "log file should exist on disk");

        log_line("test message");
        let content = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            content.contains("test message"),
            "log file should contain the written line"
        );

        // Clean up so the real app's log dir doesn't accumulate test artifacts.
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_prune_old_logs_removes_stale_keeps_fresh_and_unrelated() {
        let dir = std::env::temp_dir().join(format!("ubet_log_prune_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        // Stale (years old) → must be pruned.
        let stale = dir.join("render_20200101_000000.log");
        // Fresh (timestamp in the future relative to the test run) → kept.
        let fresh = dir.join("render_20990101_000000.log");
        // Not one of our log files → left alone.
        let unrelated = dir.join("readme.txt");
        std::fs::write(&stale, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        std::fs::write(&unrelated, b"x").unwrap();

        prune_old_logs(&dir, 7);

        assert!(!stale.exists(), "stale log should be pruned");
        assert!(fresh.exists(), "fresh log should be kept");
        assert!(unrelated.exists(), "unrelated files should be left alone");

        let _ = std::fs::remove_file(&fresh);
        let _ = std::fs::remove_file(&unrelated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_prune_old_logs_ignores_malformed_names() {
        let dir = std::env::temp_dir().join(format!("ubet_log_prune_bad_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let malformed = dir.join("render_not_a_timestamp.log");
        std::fs::write(&malformed, b"x").unwrap();

        prune_old_logs(&dir, 7);

        assert!(malformed.exists(), "malformed names should be left alone");
        let _ = std::fs::remove_file(&malformed);
        let _ = std::fs::remove_dir_all(&dir);
    }


}
