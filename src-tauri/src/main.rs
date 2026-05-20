// src-tauri/src/main.rs

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod error;
mod ffmpeg;
mod models;
mod pipeline;
mod utils;

use commands::{
    hardware,
    pipeline::{cancel_render, start_render},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;
use tokio::sync::Notify;

pub struct RenderControl {
    pub notify: Notify,
    cancelled: AtomicBool,
}

impl RenderControl {
    pub fn new() -> Self {
        Self {
            notify: Notify::new(),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            hardware::detect_hardware,
            start_render,
            cancel_render,
        ])
        .setup(|app| {
            app.manage(RenderState {
                control: Mutex::new(None),
            });

            let config = config::AppConfig::default();
            std::fs::create_dir_all(&config.directories.cache).ok();
            std::fs::create_dir_all(&config.directories.output).ok();
            std::fs::create_dir_all(&config.directories.video).ok();
            std::fs::create_dir_all(&config.directories.audio).ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
