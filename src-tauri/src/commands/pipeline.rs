use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::OverrideConfig;
use crate::pipeline::Pipeline;
use crate::utils::event;
use crate::validation::validate_override_config;
use std::sync::Arc;
use tauri::AppHandle;

#[tauri::command]
pub async fn start_render(
    app: AppHandle,
    config: Option<AppConfig>,
    overrides: Option<OverrideConfig>,
    resume: Option<bool>,
) -> Result<(), String> {
    if let Some(ref ov) = overrides {
        validate_override_config(ov).map_err(|e| e.to_string())?;
    }

    let control = Arc::new(crate::RenderControl::new());

    {
        use tauri::Manager;
        let state = app.state::<crate::RenderState>();
        let mut lock = state.control.lock().map_err(|e| e.to_string())?;
        if lock.is_some() {
            return Err("A render is already in progress".into());
        }
        *lock = Some(control.clone());
    }

    let config = config.unwrap_or_default();
    let pipeline = Pipeline::new(app.clone(), config);
    let app_handle = app.clone();
    let resume_flag = resume.unwrap_or(false);
    let control_clone = control.clone();

    tokio::spawn(async move {
        let result = pipeline.execute(overrides, resume_flag, control_clone).await;

        let cleanup = || {
            use tauri::Manager;
            let state = app_handle.state::<crate::RenderState>();
            if let Ok(mut lock) = state.control.lock()
                && lock
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &control))
                {
                    *lock = None;
                }
        };

        match result {
            Ok(()) => {
                cleanup();
            }
            Err(e) => {
                let event = match e {
                    AppError::Cancelled(message) => {
                        crate::models::job::PipelineEvent::Cancelled(message)
                    }
                    other => crate::models::job::PipelineEvent::FatalError(other.to_string()),
                };
                event::emit(&app_handle, event);
                cleanup();
            }
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
