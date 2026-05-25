use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::OverrideConfig;
use crate::pipeline::Pipeline;
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
pub async fn start_render(
    app: AppHandle,
    config: Option<AppConfig>,
    overrides: Option<OverrideConfig>,
    resume: Option<bool>,
) -> Result<(), String> {
    let control = Arc::new(crate::RenderControl::new());

    {
        use tauri::Manager;
        let state = app.state::<crate::RenderState>();
        let mut lock = state.control.lock().unwrap_or_else(|e| e.into_inner());
        if lock.is_some() {
            return Err("A render is already in progress".into());
        }
        *lock = Some(control.clone());
    }

    let config = config.unwrap_or_default();
    let pipeline = Pipeline::new(app.clone(), config);
    let app_handle = app.clone();
    let resume_flag = resume.unwrap_or(false);

    tokio::spawn(async move {
        if let Err(e) = pipeline.execute(overrides, resume_flag, control.clone()).await {
            let event = match e {
                AppError::Cancelled(message) => {
                    crate::models::job::PipelineEvent::Cancelled(message)
                }
                other => crate::models::job::PipelineEvent::FatalError(other.to_string()),
            };
            crate::utils::event::emit(&app_handle, event);
        }

        use tauri::Manager;
        let state = app_handle.state::<crate::RenderState>();
        let mut lock = state.control.lock().unwrap_or_else(|e| e.into_inner());
        if lock
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &control))
        {
            *lock = None;
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_render(state: tauri::State<'_, crate::RenderState>) {
    let control = state
        .control
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(control) = control {
        control.cancel();
    }
}

#[tauri::command]
pub fn pause_render(state: tauri::State<'_, crate::RenderState>) {
    let control = state
        .control
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(control) = control {
        control.pause();
    }
}
