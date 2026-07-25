use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::OverrideConfig;
use crate::pipeline::Pipeline;
use crate::utils::event;
use crate::utils::logger;
use crate::validation::validate_override_config;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::AppHandle;

/// Caches the one-time FFmpeg/FFprobe sidecar version verification.
/// The check spawns two subprocesses and never changes within a session,
/// so we only run it once instead of on every `start_render` call.
static SIDECAR_VERIFIED: OnceLock<()> = OnceLock::new();

/// Ensures `RenderState.control` is cleared when the guard is dropped,
/// even if the spawned pipeline task panics. This prevents a stuck control
/// handle from permanently blocking every future `start_render` call.
struct ControlGuard {
    app: AppHandle,
    control: Arc<crate::RenderControl>,
}

impl Drop for ControlGuard {
    fn drop(&mut self) {
        use tauri::Manager;
        if let Ok(mut lock) = self.app.state::<crate::RenderState>().control.lock()
            && lock
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &self.control))
            {
                *lock = None;
            }
    }
}

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

    // Validate the configuration supplied by the frontend before it touches the
    // pipeline. This is the trust boundary: never trust IPC input.
    //
    // When the frontend sends no config, load the persisted config from disk
    // instead of using in-memory defaults (which contain relative paths like
    // "./videos" that may resolve to unexpected locations depending on the
    // Tauri process's CWD).
    let config = config.unwrap_or_else(AppConfig::load);
    crate::validation::validate_app_config(&config).map_err(|e| e.to_string())?;

    // Supply-chain integrity check: refuse to render with an unexpected or
    // tampered FFmpeg/FFprobe binary.
    if SIDECAR_VERIFIED.get().is_none() {
        crate::ffmpeg::verify_sidecar_binaries(&app)
            .await
            .map_err(|e| e.to_string())?;
        let _ = SIDECAR_VERIFIED.set(());
    }

    let control = Arc::new(crate::RenderControl::new());

    {
        use tauri::Manager;
        let state = app.state::<crate::RenderState>();
        let mut lock = match state.control.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                crate::utils::logger::log_line(&format!("RenderState mutex poisoned: {}", poisoned));
                poisoned.into_inner()
            }
        };
        if lock.is_some() {
            return Err("A render is already in progress".into());
        }
        *lock = Some(control.clone());
    }

    let pipeline = Pipeline::new(app.clone(), config);
    let app_handle = app.clone();
    let resume_flag = resume.unwrap_or(false);
    let control_clone = control.clone();

    tokio::spawn(async move {
        // `ControlGuard` clears `RenderState.control` on drop — including on a
        // panic inside `pipeline.execute` — so a failed render can't leave a
        // stuck control that blocks all later renders.
        //
        // It MUST live *inside* this spawned task, not in `start_render`'s own
        // scope: `start_render` returns `Ok(())` immediately after `spawn`, so a
        // guard created in the command scope would be dropped right away,
        // clearing `RenderState.control` while the pipeline is still running and
        // making `cancel_render` / `pause_render` / `resume_render` unable to
        // reach it (and allowing a second `start_render` to spawn a duplicate
        // pipeline).
        let _guard = ControlGuard {
            app: app_handle.clone(),
            control: control_clone.clone(),
        };

        let result = pipeline.execute(overrides, resume_flag, control_clone).await;

        match result {
            Ok(()) => {}
            Err(e) => {
                let event = match e {
                    AppError::Cancelled(message) => {
                        crate::models::job::PipelineEvent::Cancelled(message)
                    }
                    AppError::Paused(_) => {
                        // `pause_render` already emitted `Paused`; emitting it again
                        // here would trigger a duplicate frontend notification.
                        return;
                    }
                    other => crate::models::job::PipelineEvent::FatalError(other.to_string()),
                };
                event::emit(&app_handle, event);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_render(state: tauri::State<'_, crate::RenderState>) {
    let control = match state.control.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            crate::utils::logger::log_line(&format!("RenderState mutex poisoned: {}", poisoned));
            poisoned.into_inner().clone()
        }
    };
    if let Some(control) = control {
        control.cancel();
    }
}

#[tauri::command]
pub fn pause_render(app: tauri::AppHandle, state: tauri::State<'_, crate::RenderState>) {
    let control = match state.control.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            crate::utils::logger::log_line(&format!("RenderState mutex poisoned: {}", poisoned));
            poisoned.into_inner().clone()
        }
    };
    if let Some(control) = control {
        control.pause();
        event::emit(&app, crate::models::job::PipelineEvent::Paused);
    }
}

/// Persist the user's configuration to the app config directory.
/// Called by the frontend whenever the user changes any setting.
/// Returns an error when the config contains invalid values so the frontend
/// can surface the issue immediately.
#[tauri::command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    // Validate the full configuration before persisting. This prevents a
    // compromised or buggy frontend from writing dangerous paths or FFmpeg
    // parameters to the persisted config file.
    crate::validation::validate_app_config(&config).map_err(|e| e.to_string())?;

    // Warn if encoder contains "av1" — AV1 hardware support is not guaranteed
    // on all systems and will only be verified at render time.
    if config.video.encoder.to_ascii_lowercase().contains("av1") {
        logger::log_line("WARNING: AV1 encoder configured — verify hardware support before rendering.");
    }

    config.save().map_err(|e| e.to_string())?;
    logger::log_line("Configuration saved");
    Ok(())
}

/// Resumes a pipeline that was paused via [`pause_render`].
///
/// Returns `true` when an in-flight (paused) pipeline was actually resumed, or
/// `false` when there is no live pipeline to resume. This lets the frontend
/// fall back to starting a fresh pipeline from the saved state file when the
/// previous run already terminated.
#[tauri::command]
pub fn resume_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::RenderState>,
) -> bool {
    let control = match state.control.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            crate::utils::logger::log_line(&format!("RenderState mutex poisoned: {}", poisoned));
            poisoned.into_inner().clone()
        }
    };
    if let Some(control) = control {
        let resumed = control.resume();
        if resumed {
            event::emit(&app, crate::models::job::PipelineEvent::Log {
                level: "info".into(),
                message: "Render resumed".into(),
            });
        }
        resumed
    } else {
        false
    }
}

