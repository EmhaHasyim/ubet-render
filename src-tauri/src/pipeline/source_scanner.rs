use crate::error::AppError;
use crate::models::job::PipelineEvent;
use crate::models::settings::{MediaSource, OverrideConfig};
use crate::pipeline::estimator::{AUDIO_EXTENSIONS, VIDEO_EXTENSIONS};
use crate::utils::{event, fs};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub async fn scan_source_files(
    app: &AppHandle,
    overrides: &Option<OverrideConfig>,
    default_dir: &Path,
    media_type: &str,
    allowed_roots: &[PathBuf],
) -> Result<Vec<String>, AppError> {
    let extensions: &[&str] = match media_type {
        "video" => VIDEO_EXTENSIONS,
        "audio" => AUDIO_EXTENSIONS,
        _ => &[],
    };
    let source = match (media_type, overrides.as_ref()) {
        ("video", Some(ov)) => ov.video_source.as_ref(),
        ("audio", Some(ov)) => ov.audio_source.as_ref(),
        _ => None,
    };

    let mut files = match source {
        Some(MediaSource::Folder { path }) => {
            let p = Path::new(path);
            let _ = crate::validation::resolve_and_validate_path(p, allowed_roots)?;
            scan_and_validate_dir(app, &fs::to_absolute(p), extensions, allowed_roots).await
        }
        Some(MediaSource::Files { paths }) => {
            let mut all_files = Vec::new();
            for p_str in paths {
                let p = fs::to_absolute(Path::new(p_str));
                if p.is_dir() {
                    let _ = crate::validation::resolve_and_validate_path(&p, allowed_roots)?;
                    all_files.extend(
                        scan_and_validate_dir(app, &p, extensions, allowed_roots).await,
                    );
                } else if p.is_file() {
                    let lower = p_str.to_lowercase();
                    if extensions.iter().any(|ext| lower.ends_with(ext))
                        && crate::validation::resolve_and_validate_path(&p, allowed_roots).is_ok()
                    {
                        all_files.push(p.to_string_lossy().to_string());
                    } else {
                        event::emit(
                            app,
                            PipelineEvent::Log {
                                level: "warn".into(),
                                message: format!("Skipping disallowed or unsupported file: {}", p_str),
                            },
                        );
                    }
                } else {
                    event::emit(
                        app,
                        PipelineEvent::Log {
                            level: "warn".into(),
                            message: format!("Skipping missing path: {}", p_str),
                        },
                    );
                }
            }
            all_files
        }
        None => {
            let _ = crate::validation::resolve_and_validate_path(default_dir, allowed_roots)?;
            scan_and_validate_dir(app, &fs::to_absolute(default_dir), extensions, allowed_roots).await
        }
    };
    files.sort_by(|a, b| fs::compare_natural(a, b));
    let mut seen = HashSet::new();
    files.retain(|f| {
        std::path::Path::new(f)
            .canonicalize()
            .ok()
            .is_some_and(|p| seen.insert(p))
    });
    Ok(files)
}

async fn scan_and_validate_dir(
    app: &AppHandle,
    dir: &Path,
    extensions: &[&str],
    allowed_roots: &[PathBuf],
) -> Vec<String> {
    let scanned = fs::scan_files(dir, extensions).await;
    let mut valid = Vec::with_capacity(scanned.len());
    for path_str in scanned {
        let p = Path::new(&path_str);
        if crate::validation::resolve_and_validate_path(p, allowed_roots).is_ok() {
            valid.push(path_str);
        } else {
            event::emit(
                app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!("Skipping file outside allowed directory: {}", path_str),
                },
            );
        }
    }
    valid
}
