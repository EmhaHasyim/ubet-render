use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::settings::{MediaSource, OverrideConfig};
use crate::utils::fs;
use std::path::{Path, PathBuf};

/// Canonicalized directory paths resolved once at the start of
/// [`Pipeline::execute`](super::Pipeline::execute).  Keeps all
/// root-resolution logic in one place and passes a single struct
/// into `execute()` instead of a dozen intermediate locals.
pub(crate) struct ResolvedRoots {
    pub output_dir: PathBuf,
    pub input_roots: Vec<PathBuf>,
    pub cache_dir: PathBuf,
    pub thumb_dir: PathBuf,
    pub state_path: PathBuf,
}

/// Canonicalize a path for use in `allowed_roots` so that the comparison in
/// `resolve_and_validate_path` (which uses `canonicalize()`) matches casing,
/// especially on Windows where `Path::starts_with` is case-sensitive.
fn canonicalize_for_root(p: PathBuf) -> PathBuf {
    p.canonicalize().unwrap_or(p)
}

/// Register override source roots — both folder and per-file parents — so
/// path validation succeeds for every source path the user selected.
fn add_override_source_roots(
    source: &MediaSource,
    media_label: &str,
    input_roots: &mut Vec<PathBuf>,
    allowed_roots: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    match source {
        MediaSource::Folder { path } => {
            if crate::validation::is_system_protected_path(Path::new(path)) {
                return Err(AppError::Pipeline(format!(
                    "{} source resolves inside a system-protected location: {}",
                    media_label, path,
                )));
            }
            let root = canonicalize_for_root(fs::to_absolute(Path::new(path)));
            input_roots.push(root.clone());
            allowed_roots.push(root);
        }
        MediaSource::Files { paths } => {
            for p in paths {
                if let Some(parent) = Path::new(p).parent() {
                    if crate::validation::is_system_protected_path(parent) {
                        return Err(AppError::Pipeline(format!(
                            "{} source resolves inside a system-protected location: {}",
                            media_label, p,
                        )));
                    }
                    let root = canonicalize_for_root(fs::to_absolute(parent));
                    input_roots.push(root.clone());
                    allowed_roots.push(root);
                }
            }
        }
    }
    Ok(())
}

/// Build the set of validated directory roots that the rest of
/// `Pipeline::execute` depends on.
pub(crate) fn resolve_roots(
    config: &AppConfig,
    overrides: &Option<OverrideConfig>,
) -> Result<ResolvedRoots, AppError> {
    let output_dir = fs::to_absolute(Path::new(
        overrides
            .as_ref()
            .and_then(|ov| ov.output_path.as_deref())
            .unwrap_or(&config.directories.output),
    ));
    if crate::validation::is_system_protected_path(&output_dir) {
        return Err(AppError::Pipeline(format!(
            "Output directory resolves inside a system-protected location and cannot be used: {}",
            output_dir.display(),
        )));
    }

    let video_root = canonicalize_for_root(fs::to_absolute(Path::new(&config.directories.video)));
    let audio_root = canonicalize_for_root(fs::to_absolute(Path::new(&config.directories.audio)));

    // Keep input roots separate from output roots. A resumed state file is
    // untrusted; allowing `output_dir` here would let a tampered state make
    // FFmpeg read arbitrary files from the render destination.
    let mut input_roots = vec![video_root, audio_root];
    let mut allowed_roots = vec![canonicalize_for_root(output_dir.clone())];
    allowed_roots.extend(input_roots.iter().cloned());

    // Add override source directories to allowed roots so path validation
    // passes. Folder sources must be added explicitly; file sources are
    // covered by their parents, but the folder path itself is not a parent
    // of its children.
    if let Some(ov) = overrides {
        if let Some(ref vs) = ov.video_source {
            add_override_source_roots(vs, "Video", &mut input_roots, &mut allowed_roots)?;
        }
        if let Some(ref a_src) = ov.audio_source {
            add_override_source_roots(a_src, "Audio", &mut input_roots, &mut allowed_roots)?;
        }
        if let Some(ref output_path) = ov.output_path {
            let _ = crate::validation::resolve_and_validate_path(
                Path::new(output_path),
                &allowed_roots,
            )?;
        }
    }

    // The frontend historically sent `./cache` as a placeholder while
    // the backend defaulted to the platform temp directory. Preserve that
    // safe default, but honor an explicitly configured cache directory.
    let configured_cache = fs::to_absolute(Path::new(&config.directories.cache));
    let legacy_cache = fs::to_absolute(Path::new("./cache"));
    let cache_root = if configured_cache == legacy_cache {
        fs::ubet_temp_dir().join("cache")
    } else {
        configured_cache
    };
    if crate::validation::is_system_protected_path(&cache_root) {
        return Err(AppError::Pipeline(format!(
            "Cache directory resolves inside a system-protected location: {}",
            cache_root.display(),
        )));
    }

    // Never treat the configured cache root as disposable user data. The
    // pipeline owns only this per-output namespace below it, which is safe
    // to clear between fresh runs and stable across pause/resume.
    let cache_dir = fs::render_cache_dir(&cache_root, &output_dir);
    if crate::validation::is_system_protected_path(&cache_dir) {
        return Err(AppError::Pipeline(format!(
            "Render cache resolves inside a system-protected location: {}",
            cache_dir.display(),
        )));
    }

    let thumb_dir = fs::ubet_temp_dir().join("thumbnails");
    let state_path = output_dir.join("ubet_render_state.json");

    Ok(ResolvedRoots {
        output_dir,
        input_roots,
        cache_dir,
        thumb_dir,
        state_path,
    })
}
