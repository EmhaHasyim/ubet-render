//! Workspace lifecycle guard for a render run.
//!
//! Owns the disposable directories/files of one render (cache, thumbnails,
//! state file) and removes them on drop unless the run's outcome asked to
//! keep them (`pause` / `complete`). Extracted from `pipeline/mod.rs` so the
//! orchestrator only orchestrates.

use std::path::{Path, PathBuf};

pub(super) struct WorkspaceGuard {
    cache_dir: PathBuf,
    thumbnail_dir: PathBuf,
    state_path: PathBuf,
    keep_cache: bool,
    keep_thumbnails: bool,
    keep_state: bool,
}

impl WorkspaceGuard {
    pub(super) fn new(cache_dir: PathBuf, thumbnail_dir: PathBuf, state_path: PathBuf) -> Self {
        Self {
            cache_dir,
            thumbnail_dir,
            state_path,
            // Cache is disposable by default. Pause explicitly opts into
            // retaining it so a resume can reuse prepared audio.
            keep_cache: false,
            // Thumbnails are user-visible after a successful render and are
            // retained unless the user cancels.
            keep_thumbnails: true,
            // Keep state on unexpected failure so retry/resume remains useful.
            keep_state: true,
        }
    }

    pub(super) fn pause(&mut self) {
        self.keep_cache = true;
        self.keep_thumbnails = true;
        self.keep_state = true;
    }

    pub(super) fn cancel(&mut self) {
        self.keep_cache = false;
        self.keep_thumbnails = false;
        self.keep_state = false;
    }

    pub(super) fn complete(&mut self) {
        self.keep_cache = false;
        self.keep_thumbnails = true;
        self.keep_state = false;
    }
}

impl Drop for WorkspaceGuard {
    fn drop(&mut self) {
        let remove_dir = |path: &Path, keep: bool| {
            if !keep
                && let Err(error) = std::fs::remove_dir_all(path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                crate::utils::logger::log_line(&format!(
                    "Workspace cleanup failed for '{}': {}",
                    path.display(),
                    error
                ));
            }
        };
        let remove_file = |path: &Path, keep: bool| {
            if !keep
                && let Err(error) = std::fs::remove_file(path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                crate::utils::logger::log_line(&format!(
                    "Workspace cleanup failed for '{}': {}",
                    path.display(),
                    error
                ));
            }
        };
        remove_dir(&self.cache_dir, self.keep_cache);
        remove_dir(&self.thumbnail_dir, self.keep_thumbnails);
        remove_file(&self.state_path, self.keep_state);
    }
}

/// Move an invalid render-state file aside (quarantine) so a corrupt or
/// oversized state cannot poison later resumes. Returns true when renamed.
pub(super) fn quarantine_state_file(path: &Path, timestamp: u64) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(timestamp as u128);
    let quarantine = path.with_file_name(format!("{}.invalid-{}-{}", file_name, timestamp, nonce));
    match std::fs::rename(path, &quarantine) {
        Ok(()) => true,
        Err(error) => {
            crate::utils::logger::log_line(&format!(
                "Unable to quarantine invalid render state '{}': {}",
                path.display(),
                error
            ));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ws_guard_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn drop_removes_dirs_and_state_by_default() {
        let cache = temp_dir("cache");
        let thumbs = temp_dir("thumbs");
        let state = temp_dir("state");
        let state_path = state.join("state.json");
        std::fs::write(&state_path, "{}").expect("write state");

        {
            let _guard = WorkspaceGuard::new(cache.clone(), thumbs.clone(), state_path.clone());
        }

        assert!(!cache.exists(), "cache should be removed on drop");
        // State is kept by default so retry/resume remains useful.
        assert!(state_path.exists(), "state file kept by default");
        // Thumbnails are kept by default (user-visible after success).
        assert!(thumbs.exists(), "thumbnails kept by default");

        let _ = std::fs::remove_dir_all(&thumbs);
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn pause_keeps_everything() {
        let cache = temp_dir("cache");
        let thumbs = temp_dir("thumbs");
        let state = temp_dir("state");
        let state_path = state.join("state.json");
        std::fs::write(&state_path, "{}").expect("write state");

        {
            let mut guard = WorkspaceGuard::new(cache.clone(), thumbs.clone(), state_path.clone());
            guard.pause();
        }

        assert!(cache.exists(), "pause keeps cache");
        assert!(thumbs.exists(), "pause keeps thumbnails");
        assert!(state_path.exists(), "pause keeps state");

        let _ = std::fs::remove_dir_all(&cache);
        let _ = std::fs::remove_dir_all(&thumbs);
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn cancel_drops_thumbnails_and_state() {
        let cache = temp_dir("cache");
        let thumbs = temp_dir("thumbs");
        let state = temp_dir("state");
        let state_path = state.join("state.json");
        std::fs::write(&state_path, "{}").expect("write state");

        {
            let mut guard = WorkspaceGuard::new(cache.clone(), thumbs.clone(), state_path.clone());
            guard.pause();
            guard.cancel();
        }

        assert!(!cache.exists(), "cancel removes cache");
        assert!(!thumbs.exists(), "cancel removes thumbnails");
        assert!(!state_path.exists(), "cancel removes state");

        let _ = std::fs::remove_dir_all(&cache);
        let _ = std::fs::remove_dir_all(&thumbs);
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn complete_keeps_thumbnails_only() {
        let cache = temp_dir("cache");
        let thumbs = temp_dir("thumbs");
        let state = temp_dir("state");
        let state_path = state.join("state.json");
        std::fs::write(&state_path, "{}").expect("write state");

        {
            let mut guard = WorkspaceGuard::new(cache.clone(), thumbs.clone(), state_path.clone());
            guard.pause();
            guard.complete();
        }

        assert!(!cache.exists(), "complete removes cache");
        assert!(thumbs.exists(), "complete keeps thumbnails");
        assert!(!state_path.exists(), "complete removes state");

        let _ = std::fs::remove_dir_all(&thumbs);
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn quarantine_renames_state_file() {
        let state = temp_dir("state");
        let state_path = state.join("render_state.json");
        std::fs::write(&state_path, "not json").expect("write state");

        assert!(quarantine_state_file(&state_path, 123));
        assert!(!state_path.exists(), "original file moved away");
        let quarantined = std::fs::read_dir(&state)
            .expect("list dir")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".invalid-"));
        assert!(quarantined, "quarantined copy exists");

        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn quarantine_missing_file_is_false() {
        let missing = std::env::temp_dir().join("ws_guard_missing_state_does_not_exist.json");
        assert!(!quarantine_state_file(&missing, 1));
    }
}
