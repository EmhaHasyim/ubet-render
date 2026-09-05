use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::OverrideConfig;
use crate::pipeline::Pipeline;
use crate::utils::event;
use crate::utils::logger;
use crate::validation::validate_override_config;
use futures::FutureExt;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;

/// Caches the one-time FFmpeg/FFprobe sidecar version verification.
/// The check spawns two subprocesses and never changes within a session,
/// so we only run it once instead of on every `start_render` call.
static SIDECAR_VERIFIED: OnceLock<()> = OnceLock::new();

/// Clones the active `RenderControl`, if any, recovering from a poisoned
/// mutex. Shared by the cancel/pause/resume commands.
fn current_control(
    state: &tauri::State<'_, crate::RenderState>,
) -> Option<Arc<crate::RenderControl>> {
    match state.control.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            crate::utils::logger::log_line(&format!("RenderState mutex poisoned: {}", poisoned));
            poisoned.into_inner().clone()
        }
    }
}

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
        // Clear application state before publishing termination. This makes
        // the termination acknowledgement a stronger lifecycle boundary:
        // callers observing it cannot race a stale "already running" handle.
        let state = self.app.state::<crate::RenderState>();
        let mut lock = match state.control.lock() {
            Ok(lock) => lock,
            Err(poisoned) => {
                crate::utils::logger::log_line(&format!(
                    "RenderState mutex poisoned during cleanup: {}",
                    poisoned
                ));
                poisoned.into_inner()
            }
        };
        if lock
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &self.control))
        {
            *lock = None;
        }
        drop(lock);
        self.control.mark_terminated();
        self.control.mark_cleaned();
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
                crate::utils::logger::log_line(&format!(
                    "RenderState mutex poisoned: {}",
                    poisoned
                ));
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

        let result =
            AssertUnwindSafe(pipeline.execute(overrides, resume_flag, control_clone.clone()))
                .catch_unwind()
                .await;

        // The pipeline has finished — success, fatal error, cancelled, paused,
        // or (in debug/unwind builds) panicked. Emit the terminal event before
        // signalling termination so an async cancel command cannot complete and
        // close the frontend listener before the terminal event is dispatched.
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let event = match e {
                    AppError::Cancelled(message) => {
                        crate::models::job::PipelineEvent::Cancelled(message)
                    }
                    AppError::Paused(_) => {
                        // Pause is a graceful stop-and-resume-from-state
                        // operation. Emit the acknowledgement only after the
                        // pipeline has persisted its state and committed to
                        // exiting. `resume_render` waits for guard cleanup
                        // before asking the frontend to start a fresh run.
                        control_clone.mark_terminated();
                        event::emit(&app_handle, crate::models::job::PipelineEvent::Paused);
                        return;
                    }
                    other => crate::models::job::PipelineEvent::FatalError(other.to_string()),
                };
                event::emit(&app_handle, event);
            }
            Err(_) => {
                crate::utils::logger::log_line("Render pipeline task panicked unexpectedly");
                event::emit(
                    &app_handle,
                    crate::models::job::PipelineEvent::FatalError(
                        "Render pipeline terminated unexpectedly".into(),
                    ),
                );
            }
        }
        control_clone.mark_terminated();
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_render(state: tauri::State<'_, crate::RenderState>) -> Result<bool, String> {
    let Some(control) = current_control(&state) else {
        return Ok(false);
    };
    if control.is_terminated() {
        return Ok(false);
    }
    control.cancel();
    // Cancellation is a completion acknowledgement, not merely an
    // acceptance acknowledgement. The frontend may safely close its
    // listener once this returns because the pipeline guard marks the
    // control terminated even if execute() exits through an error or
    // panic.
    match tokio::time::timeout(Duration::from_secs(30), control.wait_for_cleanup()).await {
        Ok(()) => Ok(true),
        Err(_) => {
            Err("Cancellation requested, but the render did not terminate within 30 seconds".into())
        }
    }
}

#[tauri::command]
pub fn pause_render(state: tauri::State<'_, crate::RenderState>) {
    let Some(control) = current_control(&state) else {
        return;
    };
    // The pipeline emits `Paused` after durable state has been saved and
    // execute() has returned. Emitting here acknowledged only the request
    // and created a pause→resume teardown race.
    control.pause();
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
        logger::log_line(
            "WARNING: AV1 encoder configured — verify hardware support before rendering.",
        );
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
pub async fn resume_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::RenderState>,
) -> Result<bool, String> {
    let Some(control) = current_control(&state) else {
        return Ok(false);
    };
    // The pipeline may still be in the process of tearing down after a
    // pause (ffmpeg killed, state saved, task about to exit). A control
    // that has already committed to terminating cannot be resumed —
    // report `false` so the frontend starts a fresh pipeline from the
    // on-disk state file instead of waiting forever for events that
    // will never arrive.
    if control.is_terminated() {
        tokio::time::timeout(Duration::from_secs(30), control.wait_for_cleanup())
            .await
            .map_err(|_| "Paused render cleanup timed out".to_string())?;
        return Ok(false);
    }
    let resumed = control.resume();
    if resumed {
        event::emit(
            &app,
            crate::models::job::PipelineEvent::Log {
                level: "info".into(),
                message: "Render resumed".into(),
            },
        );
    }
    Ok(resumed)
}
