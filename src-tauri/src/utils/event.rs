use crate::models::job::PipelineEvent;
use crate::utils::logger;
use tauri::Emitter;

/// Emit a [`PipelineEvent`] to the frontend **and** persist it to the log
/// file (when the logger has been initialised). High-frequency events such
/// as `Progress` and `Stats` are written to the log but NOT to the frontend
/// when the event type would be too verbose — instead they are already sent
/// via their dedicated channels.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_log_event() {
        let event = PipelineEvent::Log {
            level: "info".into(),
            message: "test message".into(),
        };
        let formatted = format_pipeline_event(&event);
        assert_eq!(formatted, "[INFO] test message");
    }

    #[test]
    fn test_format_done_event() {
        let event = PipelineEvent::Done {
            completed: 5,
            total: 10,
            failed: 1,
        };
        let formatted = format_pipeline_event(&event);
        assert_eq!(formatted, "DONE 5/10 completed, 1 failed");
    }

    #[test]
    fn test_format_cancelled() {
        let event = PipelineEvent::Cancelled("by user".into());
        let formatted = format_pipeline_event(&event);
        assert!(formatted.contains("CANCELLED"));
    }

}
