use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Replace `destination` with `source` using the platform's replacement
/// primitive. Both paths must be on the same filesystem.
///
/// POSIX rename replaces an existing destination atomically. Windows needs
/// `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` for the same guarantee; a
/// remove-then-rename fallback would create a visible gap and could lose the
/// previous file if the process stops between operations.
pub fn atomic_replace(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };

        let source_wide: Vec<u16> = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(source, destination)
    }
}

/// Write a file durably and replace its destination atomically.
///
/// The complete operation runs on Tokio's blocking pool so callers do not
/// block the async runtime while flushing a potentially large artifact.
pub async fn atomic_write(path: &Path, contents: Vec<u8>) -> Result<(), std::io::Error> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "artifact".into());
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let temp = path.with_file_name(format!(
            ".{}.tmp-{}-{}",
            file_name,
            std::process::id(),
            nonce
        ));

        let result = (|| {
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(&contents)?;
            file.sync_all()?;
            atomic_replace(&temp, &path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    })
    .await
    .map_err(|error| std::io::Error::other(format!("atomic write task failed: {}", error)))?
}

#[cfg(test)]
mod atomic_replace_tests {
    use super::{atomic_replace, atomic_write};
    use std::path::PathBuf;

    #[test]
    fn atomic_replace_replaces_existing_file() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "ubet_atomic_replace_{}_{}",
            std::process::id(),
            nonce
        ));
        let source = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&path, b"old").unwrap();
        std::fs::write(&source, b"new").unwrap();

        atomic_replace(&source, &path).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!source.exists());
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "ubet_atomic_write_{}_{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, b"old").unwrap();

        atomic_write(&path, b"new".to_vec()).await.unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let _ = std::fs::remove_file(path);
    }
}

/// Shared temp directory for ubet-render (cache, thumbnails, logs).
/// Returns `{TEMP}/ubet-render`.
pub fn ubet_temp_dir() -> PathBuf {
    std::env::temp_dir().join("ubet-render")
}

/// Returns an app-owned cache namespace for one output destination.
///
/// The configured cache path is a user-owned root and must never be removed
/// recursively by the pipeline. All disposable render files live below this
/// reserved namespace instead. Deriving the leaf from the output path keeps a
/// paused render and its resume invocation on the same cache directory while
/// isolating different output destinations from one another.
pub fn render_cache_dir(configured_cache: &Path, output_dir: &Path) -> PathBuf {
    configured_cache.join(".ubet-render-cache").join(format!(
        "{:016x}",
        hash_path(output_dir.to_string_lossy().as_bytes())
    ))
}

#[cfg(test)]
mod render_cache_tests {
    use super::render_cache_dir;
    use std::path::Path;

    #[test]
    fn render_cache_dir_is_nested_and_stable() {
        let configured = Path::new("C:/user-cache");
        let output = Path::new("C:/renders");
        let first = render_cache_dir(configured, output);
        let second = render_cache_dir(configured, output);

        assert_eq!(first, second);
        assert!(first.starts_with(configured));
        assert_ne!(first, configured);
        assert!(first.to_string_lossy().contains(".ubet-render-cache"));
    }
}

/// Result of a bounded recursive media scan.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanFilesResult {
    pub files: Vec<String>,
    pub truncated: bool,
    pub incomplete: bool,
}

pub fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// Ensure a directory exists. `create_dir_all` is idempotent so the
/// previous `try_exists` guard was removed — it added an unnecessary syscall
/// without providing any correctness benefit.
pub async fn ensure_dir(dir: &Path) -> Result<(), std::io::Error> {
    tokio::fs::create_dir_all(dir).await
}

pub async fn safe_delete(file: &Path) -> Result<(), std::io::Error> {
    match tokio::fs::remove_file(file).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Synchronous variant of `safe_delete` for callers that cannot await
/// (e.g. inside an `async move` closure that is itself `async`).
/// Used by the audio-pool's at-least-once tmp-file cleanup on ffmpeg
/// failure paths.
pub fn safe_delete_sync(file: &Path) -> Result<(), std::io::Error> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Hash input bytes to a deterministic 64-bit FNV-1a value.
/// Suitable for cache names and quick lookups where collision probability is
/// acceptable; this is not a cryptographic integrity primitive.
pub fn hash_path(data: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Return a content-aware signature for a file.
///
/// Size and modification time are useful fast-path metadata, but neither is
/// sufficient for cache invalidation: applications can replace a file while
/// preserving both values (for example, a same-size rewrite within a coarse
/// filesystem timestamp resolution). Include the complete file content in a
/// pair of deterministic 64-bit hashes so an in-place replacement cannot
/// silently reuse an encoded cache entry. This is intentionally not a
/// cryptographic integrity check; it is a cache fingerprint, not a security
/// primitive.
pub fn file_signature(path: &Path) -> Result<String, std::io::Error> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    let mut file = std::fs::File::open(path)?;
    // Keep the streaming fingerprint deterministic across process launches
    // and Rust toolchain versions. `DefaultHasher` is not a stable cache
    // format, so use two explicit FNV-1a streams instead.
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut first = OFFSET;
    let mut second = OFFSET ^ 0x5a5a5a5a5a5a5a5a;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            first ^= u64::from(*byte);
            first = first.wrapping_mul(PRIME);
            second ^= u64::from(*byte);
            second = second.wrapping_mul(PRIME);
        }
    }
    Ok(format!(
        "{}:{}:{}:{:016x}{:016x}",
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos(),
        first,
        second
    ))
}

pub fn hash_path128(data: &[u8]) -> u128 {
    // Use two deterministic FNV-1a streams with different initial offsets.
    // Cache names remain stable across process launches and Rust versions.
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hi = OFFSET;
    let mut lo = OFFSET ^ 0x5a5a5a5a5a5a5a5a;
    for byte in data {
        hi ^= u64::from(*byte);
        hi = hi.wrapping_mul(PRIME);
        lo ^= u64::from(*byte);
        lo = lo.wrapping_mul(PRIME);
    }
    (u128::from(hi) << 64) | u128::from(lo)
}

pub async fn scan_files(dir: &Path, extensions: &[&str]) -> ScanFilesResult {
    const MAX_SCAN_FILES: usize = 10_000;
    const MAX_VISITED_DIRS: usize = 100_000;
    match tokio::fs::metadata(dir).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return ScanFilesResult::default(),
        Err(_) => {
            return ScanFilesResult {
                incomplete: true,
                ..ScanFilesResult::default()
            };
        }
    }
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut visited = HashSet::new();
    let mut incomplete = false;
    match tokio::fs::canonicalize(dir).await {
        Ok(canonical) => {
            visited.insert(canonical);
        }
        Err(_) => {
            incomplete = true;
        }
    }
    while let Some(current_dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(current_dir).await {
            Ok(entries) => entries,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => {
                    incomplete = true;
                    break;
                }
            };
            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if extensions.iter().any(|ext| lower.ends_with(ext)) {
                    if files.len() >= MAX_SCAN_FILES {
                        return ScanFilesResult {
                            files,
                            truncated: true,
                            incomplete,
                        };
                    }
                    files.push(entry.path().to_string_lossy().to_string());
                }
            } else if file_type.is_dir() {
                let canonical = match tokio::fs::canonicalize(entry.path()).await {
                    Ok(path) => path,
                    Err(_) => {
                        incomplete = true;
                        entry.path()
                    }
                };
                if visited.insert(canonical) {
                    if visited.len() >= MAX_VISITED_DIRS {
                        return ScanFilesResult {
                            files,
                            truncated: true,
                            incomplete,
                        };
                    }
                    stack.push(entry.path());
                }
            }
        }
    }
    ScanFilesResult {
        files,
        truncated: false,
        incomplete,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Chunk<'a> {
    Num(u128, &'a str),
    Str(&'a str),
}

impl Ord for Chunk<'_> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (Chunk::Num(n1, s1), Chunk::Num(n2, s2)) => {
                if n1 != n2 {
                    n1.cmp(n2)
                } else {
                    s1.cmp(s2)
                }
            }
            (Chunk::Num(_, _), Chunk::Str(_)) => std::cmp::Ordering::Less,
            (Chunk::Str(_), Chunk::Num(_, _)) => std::cmp::Ordering::Greater,
            (Chunk::Str(s1), Chunk::Str(s2)) => compare_string_case_insensitive(s1, s2),
        }
    }
}

impl PartialOrd for Chunk<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_string_case_insensitive(s1: &str, s2: &str) -> std::cmp::Ordering {
    // `to_ascii_lowercase()` returns a `char` with no heap allocation, unlike
    // `to_lowercase()` which can allocate for Unicode case mappings. Filenames
    // are overwhelmingly ASCII, so this is both cheaper and sufficient here.
    let mut chars1 = s1.chars();
    let mut chars2 = s2.chars();

    loop {
        match (chars1.next(), chars2.next()) {
            (Some(c1), Some(c2)) => {
                let lower1 = c1.to_ascii_lowercase();
                let lower2 = c2.to_ascii_lowercase();
                match lower1.cmp(&lower2) {
                    std::cmp::Ordering::Equal => {}
                    non_eq => return non_eq,
                }
            }
            (None, None) => return s1.cmp(s2),
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
        }
    }
}

struct Chunks<'a> {
    s: &'a str,
    chars: std::iter::Peekable<std::str::CharIndices<'a>>,
}

impl<'a> Chunks<'a> {
    fn new(s: &'a str) -> Self {
        Self {
            s,
            chars: s.char_indices().peekable(),
        }
    }
}

impl<'a> Iterator for Chunks<'a> {
    type Item = Chunk<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let &(idx, c) = self.chars.peek()?;
        let is_digit = c.is_ascii_digit();
        let start = idx;
        let mut end = idx;

        while let Some(&(_, next_c)) = self.chars.peek() {
            if next_c.is_ascii_digit() == is_digit {
                let _ = self.chars.next();
                end = self
                    .chars
                    .peek()
                    .map(|&(next_idx, _)| next_idx)
                    .unwrap_or(self.s.len());
            } else {
                break;
            }
        }

        let slice = &self.s[start..end];
        if is_digit {
            if let Ok(num) = slice.parse::<u64>() {
                Some(Chunk::Num(num as u128, slice))
            } else {
                Some(Chunk::Str(slice))
            }
        } else {
            Some(Chunk::Str(slice))
        }
    }
}

pub fn compare_natural(a: &str, b: &str) -> std::cmp::Ordering {
    let mut chunks_a = Chunks::new(a);
    let mut chunks_b = Chunks::new(b);

    loop {
        match (chunks_a.next(), chunks_b.next()) {
            (Some(ca), Some(cb)) => match ca.cmp(&cb) {
                std::cmp::Ordering::Equal => {}
                non_eq => return non_eq,
            },
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------
    // to_absolute
    // -------------------------------------------------------------------

    #[test]
    fn test_to_absolute_absolute_path() {
        let p = Path::new("C:\\Windows");
        let result = to_absolute(p);
        assert!(result.is_absolute());
    }

    #[test]
    fn test_to_absolute_relative_path() {
        let p = Path::new("./videos");
        let result = to_absolute(p);
        assert!(result.is_absolute());
        assert!(result.to_string_lossy().contains("videos"));
    }

    // -------------------------------------------------------------------
    // hash_path
    // -------------------------------------------------------------------

    #[test]
    fn test_file_signature_changes_for_file_metadata() {
        let path =
            std::env::temp_dir().join(format!("ubet_file_signature_{}.tmp", std::process::id()));
        std::fs::write(&path, b"first").unwrap();
        let first = file_signature(&path).unwrap();
        // Keep the byte length equal so this test proves the signature is
        // content-aware rather than merely metadata-aware.
        std::fs::write(&path, b"other").unwrap();
        let second = file_signature(&path).unwrap();
        assert_ne!(first, second);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_hash_path_deterministic() {
        let data = b"test_data_for_hashing";
        let h1 = hash_path(data);
        let h2 = hash_path(data);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_path_different_inputs() {
        let h1 = hash_path(b"input_a");
        let h2 = hash_path(b"input_b");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_hash_path_empty() {
        let h = hash_path(b"");
        // Should not panic, returns some u64
        assert_eq!(h, hash_path(b""));
    }

    // -------------------------------------------------------------------
    // safe_delete (sync + async)
    // -------------------------------------------------------------------

    #[tokio::test]
    async fn test_safe_delete_non_existent() {
        let p = Path::new("C:\\this_path_should_not_exist_12345abcde.tmp");
        // Deleting a non-existent file should return Ok (NotFound is ignored)
        let result = safe_delete(p).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_safe_delete_existing() {
        let tmp = std::env::temp_dir().join("ubet_safe_delete_test.tmp");
        let _ = tokio::fs::write(&tmp, b"test").await;
        let result = safe_delete(&tmp).await;
        assert!(result.is_ok());
        assert!(!tmp.exists());
    }

    #[test]
    fn test_safe_delete_sync_non_existent_returns_ok() {
        let p = Path::new("C:\\this_path_should_not_exist_safe_delete_sync_67890.tmp");
        assert!(safe_delete_sync(p).is_ok());
    }

    #[test]
    fn test_safe_delete_sync_existing() {
        let tmp = std::env::temp_dir().join("ubet_safe_delete_sync_test.tmp");
        std::fs::write(&tmp, b"test").unwrap();
        let result = safe_delete_sync(&tmp);
        assert!(result.is_ok());
        assert!(!tmp.exists());
    }

    // -------------------------------------------------------------------
    // compare_natural (existing)
    // -------------------------------------------------------------------

    #[test]
    fn test_compare_natural() {
        let mut files = vec![
            "video10.mp4".to_string(),
            "video1.mp4".to_string(),
            "video2.mp4".to_string(),
            "video01.mp4".to_string(),
            "video_abc.mp4".to_string(),
        ];
        files.sort_by(|a, b| compare_natural(a, b));
        assert_eq!(
            files,
            vec![
                "video01.mp4".to_string(),
                "video1.mp4".to_string(),
                "video2.mp4".to_string(),
                "video10.mp4".to_string(),
                "video_abc.mp4".to_string(),
            ]
        );
    }
}
