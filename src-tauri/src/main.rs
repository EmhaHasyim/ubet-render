#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod error;
mod ffmpeg;
mod models;
mod pipeline;
mod utils;
mod validation;

use commands::{
    hardware,
    logger::log_to_file,
    opener::reveal_in_explorer,
    pipeline::{cancel_render, pause_render, resume_render, save_config, start_render},
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    Manager, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder},
    scope::fs::Scope as FsScope,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tokio::sync::{Notify, watch};

pub struct RenderControl {
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
    pause_tx: watch::Sender<bool>,
    pause_rx: watch::Receiver<bool>,
    /// Set once the pipeline task has finished (or is committed to exiting).
    /// Guards the pause→resume race: after this flag flips, `resume_render`
    /// must report "no live pipeline" so the frontend restarts from the
    /// saved state file instead of believing a dead pipeline resumed.
    terminated: AtomicBool,
    terminated_notify: Notify,
    cleaned: AtomicBool,
    cleanup_notify: Notify,
}

impl RenderControl {
    pub fn new() -> Self {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (pause_tx, pause_rx) = watch::channel(false);
        Self {
            cancel_tx,
            cancel_rx,
            pause_tx,
            pause_rx,
            terminated: AtomicBool::new(false),
            terminated_notify: Notify::new(),
            cleaned: AtomicBool::new(false),
            cleanup_notify: Notify::new(),
        }
    }

    /// Marks this pipeline as terminated. Called when the pipeline task is
    /// committed to exiting (after `execute` returns) and again when the
    /// control guard drops.
    pub fn mark_terminated(&self) {
        self.terminated.store(true, Ordering::SeqCst);
        self.terminated_notify.notify_waiters();
    }

    /// Wait until the pipeline task has committed to exiting.
    /// The atomic check plus a notification future avoids the check/subscribe
    /// race: a termination that happens between the two is still observed.
    pub async fn wait_for_terminated(&self) {
        loop {
            let notified = self.terminated_notify.notified();
            if self.is_terminated() {
                return;
            }
            notified.await;
        }
    }

    /// Marks the control as fully cleaned up after `RenderState.control` has
    /// been cleared by `ControlGuard`. This is deliberately separate from
    /// `terminated`: callers that need to start a new render must wait for
    /// cleanup, not merely for the worker task to begin returning.
    pub fn mark_cleaned(&self) {
        self.cleaned.store(true, Ordering::SeqCst);
        self.cleanup_notify.notify_waiters();
    }

    pub fn is_cleaned(&self) -> bool {
        self.cleaned.load(Ordering::SeqCst)
    }

    /// Wait until the old render control has been removed from application
    /// state. The atomic check after subscribing closes the notification race.
    pub async fn wait_for_cleanup(&self) {
        loop {
            let notified = self.cleanup_notify.notified();
            if self.is_cleaned() {
                return;
            }
            notified.await;
        }
    }

    /// Returns `true` once the pipeline has committed to (or already)
    /// terminated — a paused pipeline that is already exiting can no longer
    /// be resumed and must be restarted from the saved state instead.
    pub fn is_terminated(&self) -> bool {
        self.terminated.load(Ordering::SeqCst)
    }

    /// Returns a clone of the cancel receiver so external code can wait for
    /// cancellation without holding a borrow on `RenderControl`. The returned
    /// receiver sees the latest value (cancelled or not).
    pub fn subscribe_cancel(&self) -> watch::Receiver<bool> {
        self.cancel_rx.clone()
    }

    /// Returns a clone of the pause receiver so external code can wait for
    /// pause/resume toggles. The returned receiver sees the latest value.
    pub fn subscribe_pause(&self) -> watch::Receiver<bool> {
        self.pause_rx.clone()
    }

    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }

    pub fn pause(&self) {
        let _ = self.pause_tx.send(true);
    }

    /// Resumes the pipeline by setting paused state to `false`. Does nothing
    /// if the pipeline was not paused. Returns `true` when the state actually
    /// changed (i.e. the pipeline was paused and is now resumed).
    pub fn resume(&self) -> bool {
        self.pause_tx.send_if_modified(|paused| {
            if *paused {
                *paused = false;
                true
            } else {
                false
            }
        })
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    pub fn is_paused(&self) -> bool {
        *self.pause_rx.borrow()
    }

    /// Waits until the pipeline is either resumed (paused becomes false) or
    /// cancelled (cancelled becomes true). Uses `watch::Receiver::changed()`
    /// which only resolves on actual value transitions — unlike `Notify` it
    /// cannot spuriously resolve from a stale prior notification.
    pub async fn wait_for_resume(&self) {
        let mut cancel_rx = self.cancel_rx.clone();
        let mut pause_rx = self.pause_rx.clone();
        loop {
            if *cancel_rx.borrow() {
                return;
            }
            if !*pause_rx.borrow() {
                return;
            }
            // Wait for either cancel or pause to change value
            tokio::select! {
                _ = cancel_rx.changed() => {}
                _ = pause_rx.changed() => {}
            }
        }
    }
}

impl Default for RenderControl {
    fn default() -> Self {
        Self::new()
    }
}

pub struct RenderState {
    pub control: Mutex<Option<Arc<RenderControl>>>,
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn test_render_control_new_is_not_cancelled() {
        let rc = RenderControl::new();
        assert!(!rc.is_cancelled());
    }

    #[test]
    fn test_render_control_new_is_not_paused() {
        let rc = RenderControl::new();
        assert!(!rc.is_paused());
    }

    #[test]
    fn test_render_control_cancel() {
        let rc = RenderControl::new();
        assert!(!rc.is_cancelled());
        rc.cancel();
        assert!(rc.is_cancelled());
    }

    #[test]
    fn test_render_control_pause() {
        let rc = RenderControl::new();
        assert!(!rc.is_paused());
        rc.pause();
        assert!(rc.is_paused());
    }

    #[test]
    fn test_render_control_resume_returns_true_when_paused() {
        let rc = RenderControl::new();
        rc.pause();
        assert!(rc.is_paused());
        let resumed = rc.resume();
        assert!(resumed);
        assert!(!rc.is_paused());
    }

    #[test]
    fn test_render_control_resume_returns_false_when_not_paused() {
        let rc = RenderControl::new();
        let resumed = rc.resume();
        assert!(!resumed);
        assert!(!rc.is_paused());
    }

    #[test]
    fn test_render_control_subscribe_cancel() {
        let rc = RenderControl::new();
        let rx = rc.subscribe_cancel();
        assert!(!*rx.borrow());
        rc.cancel();
        assert!(*rx.borrow());
    }

    #[test]
    fn test_render_control_default() {
        let rc = RenderControl::default();
        assert!(!rc.is_cancelled());
        assert!(!rc.is_paused());
    }

    #[test]
    fn test_render_control_new_is_not_terminated() {
        let rc = RenderControl::new();
        assert!(!rc.is_terminated());
        assert!(!rc.is_cleaned());
    }

    #[tokio::test]
    async fn test_render_control_waits_for_termination() {
        let rc = Arc::new(RenderControl::new());
        let waiter = {
            let rc = Arc::clone(&rc);
            tokio::spawn(async move {
                rc.wait_for_terminated().await;
                true
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        rc.mark_terminated();
        assert!(waiter.await.unwrap());
    }

    #[tokio::test]
    async fn test_render_control_cleanup_is_distinct_from_termination() {
        let rc = Arc::new(RenderControl::new());
        rc.mark_terminated();

        let waiter = {
            let rc = Arc::clone(&rc);
            tokio::spawn(async move {
                rc.wait_for_cleanup().await;
                true
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        rc.mark_cleaned();
        assert!(waiter.await.unwrap());
    }

    #[test]
    fn test_render_control_mark_terminated() {
        let rc = RenderControl::new();
        rc.pause();
        rc.mark_terminated();
        assert!(rc.is_terminated());
        // A terminated (committed-to-exit) pipeline that happens to still be
        // paused must not report itself as resumable.
        assert!(rc.is_paused());
        assert!(rc.is_terminated());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(RenderState {
                control: Mutex::new(None),
            });

            let show_i = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit_i = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show_i, &quit_i]).build()?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Initialize the file logger so all pipeline events are captured
            // on disk even when the frontend is not visible.
            utils::logger::init_logger();
            utils::logger::log_line("=== Application started ===");

            let loaded_config = config::AppConfig::load();
            let config = match validation::validate_app_config(&loaded_config) {
                Ok(()) => loaded_config,
                Err(error) => {
                    utils::logger::log_line(&format!(
                        "Persisted config failed validation: {}. Using safe defaults.",
                        error
                    ));
                    config::AppConfig::default()
                }
            };

            for (name, path) in [
                ("cache", &config.directories.cache),
                ("output", &config.directories.output),
                ("video", &config.directories.video),
                ("audio", &config.directories.audio),
            ] {
                if let Err(error) = std::fs::create_dir_all(path) {
                    utils::logger::log_line(&format!(
                        "Failed to create {} directory '{}': {}",
                        name, path, error
                    ));
                }
            }

            {
                let scope: FsScope = app.asset_protocol_scope();
                // Only expose the thumbnails subdir to the webview via the asset
                // protocol. Output files and the processing cache stay outside
                // webview reach (hardens against a webview compromise reading
                // processed media or written outputs).
                let thumb_dir = utils::fs::ubet_temp_dir().join("thumbnails");
                let _ = scope.allow_directory(&thumb_dir, true);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            hardware::detect_hardware,
            start_render,
            cancel_render,
            pause_render,
            resume_render,
            save_config,
            reveal_in_explorer,
            log_to_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
