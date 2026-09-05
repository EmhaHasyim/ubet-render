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
            crate::validation::sanitize_path(path)?;
            let p = Path::new(path);
            let _ = crate::validation::resolve_and_validate_path(p, allowed_roots)?;
            scan_and_validate_dir(app, &fs::to_absolute(p), extensions, allowed_roots).await?
        }
        Some(MediaSource::Files { paths }) => {
            let mut all_files = Vec::new();
            for p_str in paths {
                if let Err(error) = crate::validation::sanitize_path(p_str) {
                    event::emit(
                        app,
                        PipelineEvent::Log {
                            level: "warn".into(),
                            message: format!(
                                "Skipping path with invalid characters or traversal: {} ({})",
                                p_str, error
                            ),
                        },
                    );
                    continue;
                }
                let p = fs::to_absolute(Path::new(p_str));
                if p.is_dir() {
                    let _ = crate::validation::resolve_and_validate_path(&p, allowed_roots)?;
                    all_files
                        .extend(scan_and_validate_dir(app, &p, extensions, allowed_roots).await?);
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
                                message: format!(
                                    "Skipping disallowed or unsupported file: {}",
                                    p_str
                                ),
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
            scan_and_validate_dir(
                app,
                &fs::to_absolute(default_dir),
                extensions,
                allowed_roots,
            )
            .await?
        }
    };
    if files.len() > crate::validation::MAX_SOURCE_FILES {
        return Err(AppError::Pipeline(format!(
            "{} source contains too many discovered files: {} > {}",
            media_type,
            files.len(),
            crate::validation::MAX_SOURCE_FILES
        )));
    }
    files.sort_by(|a, b| fs::compare_natural(a, b));
    // Dedupe by canonical path off the async executor: `canonicalize` is
    // blocking I/O and this runs over up to 10k files.
    let canonical: Vec<Option<PathBuf>> = {
        let files_clone = files.clone();
        tokio::task::spawn_blocking(move || {
            files_clone
                .iter()
                .map(|f| std::path::Path::new(f).canonicalize().ok())
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default()
    };
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(files.len());
    for (original, canon) in files.into_iter().zip(canonical) {
        let key = canon.unwrap_or_else(|| PathBuf::from(&original));
        if seen.insert(key) {
            deduped.push(original);
        }
    }
    Ok(deduped)
}

async fn scan_and_validate_dir(
    app: &AppHandle,
    dir: &Path,
    extensions: &[&str],
    allowed_roots: &[PathBuf],
) -> Result<Vec<String>, AppError> {
    let scanned = fs::scan_files(dir, extensions).await;
    if scanned.truncated || scanned.incomplete {
        let reason = if scanned.truncated {
            format!(
                "Recursive scan exceeded the {}-file safety limit",
                crate::validation::MAX_SOURCE_FILES
            )
        } else {
            "Recursive scan encountered a filesystem error".into()
        };
        event::emit(
            app,
            PipelineEvent::Log {
                level: "error".into(),
                message: format!("{}; render aborted to avoid incomplete output", reason),
            },
        );
        return Err(AppError::Pipeline(reason));
    }
    let mut valid = Vec::with_capacity(scanned.files.len());
    for path_str in scanned.files {
        // Apply the same boundary validation to files discovered by a
        // recursive scan as to explicit IPC paths. A local filename can still
        // contain control characters or newline characters that would corrupt
        // concat playlists/metadata if passed through unchecked.
        if crate::validation::sanitize_path(&path_str).is_err() {
            event::emit(
                app,
                PipelineEvent::Log {
                    level: "warn".into(),
                    message: format!("Skipping file with invalid path characters: {}", path_str),
                },
            );
            continue;
        }
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
    Ok(valid)
}
