use crate::models::job::PipelineEvent;
use tauri::Emitter;

pub fn emit(app_handle: &tauri::AppHandle, event: PipelineEvent) {
    let _ = app_handle.emit("pipeline-event", event);
}
