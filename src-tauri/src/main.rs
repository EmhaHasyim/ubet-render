
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
    pipeline::{cancel_render, pause_render, resume_render, start_render},
};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    scope::fs::Scope as FsScope,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tokio::sync::Notify;

pub struct RenderControl {
    cancel_notify: Notify,
    pause_notify: Notify,
    resume_notify: Notify,
    cancelled: AtomicBool,
    paused: AtomicBool,
}

impl RenderControl {
    pub fn new() -> Self {
        Self {
            cancel_notify: Notify::new(),
            pause_notify: Notify::new(),
            resume_notify: Notify::new(),
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        }
    }

    pub fn cancel_notify(&self) -> &Notify {
        &self.cancel_notify
    }

    pub fn pause_notify(&self) -> &Notify {
        &self.pause_notify
    }

    pub fn resume_notify(&self) -> &Notify {
        &self.resume_notify
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel_notify.notify_waiters();
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.pause_notify.notify_waiters();
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.resume_notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub async fn wait_for_resume(&self) {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            if !self.paused.load(Ordering::Acquire) {
                return;
            }
            tokio::select! {
                _ = self.resume_notify.notified() => {}
                _ = self.cancel_notify.notified() => {}
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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

            let config = config::AppConfig::default();
            std::fs::create_dir_all(&config.directories.cache).ok();
            std::fs::create_dir_all(&config.directories.output).ok();
            std::fs::create_dir_all(&config.directories.video).ok();
            std::fs::create_dir_all(&config.directories.audio).ok();

            {
                let scope: FsScope = app.asset_protocol_scope();
                let abs_output = crate::utils::fs::to_absolute(Path::new(&config.directories.output));
                let _ = scope.allow_directory(&abs_output, true);
                let abs_cache = crate::utils::fs::to_absolute(Path::new(&config.directories.cache));
                let _ = scope.allow_directory(&abs_cache, true);
                let temp_dir = std::env::temp_dir().join("ubet-render");
                let _ = scope.allow_directory(&temp_dir, true);
            }

            Ok(())
        })
        .on_window_event(|window, event| if let WindowEvent::CloseRequested { api, .. } = event {
            let _ = window.hide();
            api.prevent_close();
        })
        .invoke_handler(tauri::generate_handler![
            hardware::detect_hardware,
            start_render,
            cancel_render,
            pause_render,
            resume_render,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
