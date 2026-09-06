use crate::models::job::PipelineEvent;
use crate::utils::logger;
use tauri::Emitter;

/// Emit a [`PipelineEvent`] to the frontend **and** persist it to the log
/// file (when the logger has been initialised). High-frequency events such
/// as `Progress` and `Stats` are forwarded to the frontend but skipped from
/// the on-disk log: they arrive many times per second and writing every one
/// would bloat the log by megabytes over a long render.
pub fn emit(app_handle: &tauri::AppHandle, event: PipelineEvent) {
    // Persist to the on-disk log file (best-effort).
    // High-frequency events (Progress, Stats) are skipped to avoid log bloat:
    // they're already visible in the frontend and writing every frame/update
    // to disk would generate megabytes of data for long renders.
    if !matches!(
        event,
        PipelineEvent::Progress { .. } | PipelineEvent::Stats { .. }
    ) {
        let log_message = format_pipeline_event(&event);
        logger::log_line(&log_message);
    }

    // Forward to the frontend.
    let _ = app_handle.emit("pipeline-event", event);
}

/// Converts a [`PipelineEvent`] to a human-readable log line.
fn format_pipeline_event(event: &PipelineEvent) -> String {
    match event {
        PipelineEvent::Log { level, message } => {
            format!("[{}] {}", level.to_uppercase(), message)
        }
        PipelineEvent::Done {
            completed,
            total,
            failed,
        } => {
            format!("DONE {}/{} completed, {} failed", completed, total, failed)
        }
        PipelineEvent::Cancelled(msg) => {
            format!("CANCELLED: {}", msg)
        }
        PipelineEvent::Paused => "PAUSED".to_string(),
        PipelineEvent::FatalError(msg) => {
            format!("FATAL: {}", msg)
        }
        // Unreachable in production: `emit` filters Progress/Stats before
        // calling the formatter. Kept as a wildcard for exhaustive matching.
        _ => String::new(),
    }
}
