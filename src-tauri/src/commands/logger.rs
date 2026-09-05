use crate::utils::logger;
use serde::Deserialize;

/// Frontend log entry forwarded from the SolidJS `createLogger()` logger so
/// frontend-side diagnostics land in the same `{TEMP}/ubet-render/logs/render_*.log`
/// file the backend writes to.
///
/// Fields are intentionally just `(level, context, message)` — timestamps are
/// added by the backend logger before the line hits disk so `tail -f` reads
/// lines in a single chronological stream regardless of origin.
#[derive(Debug, Deserialize)]
pub struct FrontendLogEntry {
    pub level: String,
    pub context: String,
    pub message: String,
}

/// Append a batch of frontend log entries to the same log file the backend
/// uses. Lines are tagged with a `[frontend]` marker so a `tail -f` of the
/// file can distinguish them from backend-emitted lines without changing
/// their timestamp formatting.
#[tauri::command]
pub fn log_to_file(entries: Vec<FrontendLogEntry>) {
    // DoS / log-forgery guard: cap batch size and strip CR/LF so one IPC
    // call cannot fill the disk or fake multi-line log entries.
    let capped = entries
        .into_iter()
        .take(crate::validation::limits::MAX_FRONTEND_LOG_BATCH);
    for entry in capped {
        let context = entry.context.replace(['\n', '\r'], " ");
        let level = entry.level.replace(['\n', '\r'], " ");
        let message = entry.message.replace(['\n', '\r'], " ");
        // Truncate pathological single lines (10KB cap keeps the file readable).
        let message = message.chars().take(10_000).collect::<String>();
        logger::log_line(&format!("[frontend] [{}] [{}] {}", context, level, message));
    }
}
