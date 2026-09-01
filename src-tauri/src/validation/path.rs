//! Path-safety validation: sanitization, canonicalization, protected-root
//! detection, and traversal defense. Extracted from `validation.rs` so the
//! config/override validators can stay focused on field semantics.

use crate::error::AppError;
use std::path::{Path, PathBuf};

pub(crate) use super::limits::MAX_PATH_LEN;
/// Maximum parent-directory walk depth for [`canonicalize_lenient`].
/// A depth above this value is treated as a malformed or adversarial path
/// and causes the function to return `None` rather than loop indefinitely.
const MAX_CANONICALIZE_DEPTH: usize = 256;

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "NUL", "PRN", "AUX", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Unicode characters that can be used to bypass `..` detection
const TRAVERSAL_UNICODE_VARIANTS: &[char] = &[
    '\u{2025}', // ‥  double vertical line (looks like ..)
    '\u{2026}', // …  horizontal ellipsis
    '\u{2044}', // ⁄  fraction slash (like /)
    '\u{2215}', // ∕  division slash (like /)
    '\u{FF0F}', // ／ fullwidth solidus (like /)
    '\u{FF0E}', // ． fullwidth full stop (like .)
    '\u{2E2F}', // ⸯ vertical tilde
    '\u{2E3C}', // ⸼ stenographic full stop
    '\u{2E3D}', // ⸽ vertical six dots
];

fn has_traversal_unicode(path: &str) -> bool {
    path.chars()
        .any(|c| TRAVERSAL_UNICODE_VARIANTS.contains(&c))
}

pub(crate) fn sanitize_path(path: &str) -> Result<PathBuf, AppError> {
    if path.len() > MAX_PATH_LEN {
        return Err(AppError::Pipeline(format!(
            "Path too long: {} > {}",
            path.len(),
            MAX_PATH_LEN
        )));
    }
    if path.contains('\0') {
        return Err(AppError::Pipeline("Path contains null byte".into()));
    }
    // Reject NTFS Alternate Data Streams on Windows (e.g. `video.mp4:$DATA`).
    // `:` is the drive-letter separator at byte position 1 on Windows; any
    // colon elsewhere (relative path, or a second colon after the drive
    // prefix) is an ADS marker and must be rejected.
    //
    // macOS and Linux, however, treat `:` as a perfectly legal filename
    // character (e.g. `My:Song.mp3`), so this check MUST NOT apply there —
    // doing so would make legitimate files unrenderable.
    #[cfg(windows)]
    if let Some(col_pos) = path.find(':') {
        let is_drive_colon = col_pos == 1;
        let has_second_colon = path[col_pos + 1..].contains(':');
        if !is_drive_colon || has_second_colon {
            return Err(AppError::Pipeline(
                "Path contains NTFS alternate data stream marker".into(),
            ));
        }
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(AppError::Pipeline(
            "Path contains control characters".into(),
        ));
    }
    if has_traversal_unicode(path) {
        return Err(AppError::Pipeline(
            "Path contains Unicode traversal characters".into(),
        ));
    }
    let path = Path::new(path);
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Pipeline("Path traversal detected".into()));
    }
    // Windows resolves three-or-more-dot components (..., ...., etc.) as
    // parent-directory traversal equivalent to `..` in some APIs, so they
    // must be rejected alongside the standard `ParentDir` check above.
    if path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.len() >= 3 && s.bytes().all(|b| b == b'.'))
    }) {
        return Err(AppError::Pipeline(
            "Path traversal detected (multi-dot component)".into(),
        ));
    }
    if cfg!(windows) && path.to_string_lossy().starts_with("\\\\") {
        return Err(AppError::Pipeline("UNC paths are not allowed".into()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('-') {
            return Err(AppError::Pipeline(
                "Filename starts with '-' which may be misinterpreted as a flag".into(),
            ));
        }
        if cfg!(windows) && {
            let stem = Path::new(name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(name)
                .to_ascii_uppercase();
            WINDOWS_RESERVED.contains(&stem.as_str())
        } {
            return Err(AppError::Pipeline(format!(
                "Windows reserved filename: {}",
                name
            )));
        }
    }
    Ok(path.to_path_buf())
}

pub fn resolve_and_validate_path(
    path: &Path,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, AppError> {
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = path.parent().unwrap_or(path);
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Pipeline(format!("Failed to resolve path: {}", e)))?;
            canonical_parent.join(path.file_name().unwrap_or(path.as_os_str()))
        }
    };
    let is_allowed = allowed_roots.iter().any(|root| {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        canonical.starts_with(canonical_root)
    });
    if !is_allowed {
        return Err(AppError::Pipeline(
            "Path resolves outside allowed directories".into(),
        ));
    }
    Ok(canonical)
}

/// Returns `true` if `path` resolves inside an OS/system-protected location
/// (e.g. the drive root, the Windows directory, or Unix core system dirs).
///
/// Defense-in-depth guard so the pipeline never writes rendered output into a
/// location that could damage the operating system. The directory need not
/// exist yet — the parent is canonicalized and the final component re-attached.
pub(crate) fn is_system_protected_path(path: &Path) -> bool {
    let Some(canonical) = canonicalize_lenient(path) else {
        return false;
    };

    // Bare drive/volume root, e.g. `C:\` (Windows) or `/` (Unix).
    let comps: Vec<_> = canonical.components().collect();
    #[cfg(windows)]
    {
        use std::path::Component;
        if comps.len() == 2
            && matches!(comps[0], Component::Prefix(_))
            && matches!(comps[1], Component::RootDir)
        {
            return true;
        }
    }
    #[cfg(not(windows))]
    {
        use std::path::Component;
        if comps.len() == 1 && matches!(comps[0], Component::RootDir) {
            return true;
        }
    }

    // Windows OS directory (SystemRoot / windir).
    #[cfg(windows)]
    for var in ["SystemRoot", "windir"] {
        if let Ok(val) = std::env::var(var)
            && let Some(sys) = canonicalize_lenient(Path::new(&val))
            && canonical.starts_with(&sys)
        {
            return true;
        }
    }
    // Unix core system directories.
    #[cfg(not(windows))]
    for d in [
        "/bin", "/sbin", "/usr", "/etc", "/boot", "/System", "/lib", "/lib64", "/proc", "/sys",
    ] {
        if let Some(sys) = canonicalize_lenient(Path::new(d)) {
            if canonical.starts_with(&sys) {
                return true;
            }
        }
    }
    false
}

/// Like [`std::path::Path::canonicalize`] but tolerant of paths whose final
/// components do not exist yet. Walks upward until it finds the nearest
/// existing ancestor, canonicalizes that ancestor, then appends the unresolved
/// suffix. This keeps protected-directory checks effective for nested paths
/// that would otherwise make only the immediate parent fail canonicalization.
fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    let mut unresolved = Vec::new();
    let mut depth: usize = 0;

    loop {
        depth += 1;
        if depth > MAX_CANONICALIZE_DEPTH {
            return None;
        }

        if let Ok(canonical_base) = current.canonicalize() {
            let mut result = canonical_base;
            for component in unresolved.iter().rev() {
                result.push(component);
            }
            return Some(result);
        }

        let name = current.file_name()?.to_os_string();
        unresolved.push(name);
        if !current.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_control_characters() {
        for value in ["../escape", "folder/../../escape", "bad\0name", ".../file"] {
            assert!(
                sanitize_path(value).is_err(),
                "accepted unsafe path: {value:?}"
            );
        }
    }

    #[test]
    fn rejects_unicode_traversal_variants() {
        assert!(sanitize_path("folder/‥/file.mp4").is_err());
        assert!(sanitize_path("folder／file.mp4").is_err());
    }

    #[test]
    fn rejects_flag_like_file_names() {
        assert!(sanitize_path("-input.mp4").is_err());
        assert!(sanitize_path("folder/-input.mp4").is_err());
    }
}
