use std::collections::HashSet;
use std::hash::Hasher;
use std::path::{Path, PathBuf};

/// Shared temp directory for ubet-render (cache, thumbnails, logs).
/// Returns `{TEMP}/ubet-render`.
pub fn ubet_temp_dir() -> PathBuf {
    std::env::temp_dir().join("ubet-render")
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

/// Hash input bytes to a 64-bit value using SipHash-1-3 (DefaultHasher).
/// Suitable for bloom filters and quick lookups where collision probability
/// is acceptable (< 0.0003 % for 10 000 entries).
pub fn hash_path(data: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(data);
    hasher.finish()
}

/// Hash input bytes to a 128-bit value by combining two independent
/// SipHash-1-3 outputs.  This provides ~2× the collision resistance of
/// [`hash_path`] without pulling in a crypto dependency — sufficient for
/// cache-key deduplication across hundreds of thousands of entries.
pub fn hash_path128(data: &[u8]) -> u128 {
    // First pass: hash the data as-is.
    let mut h1 = std::collections::hash_map::DefaultHasher::new();
    h1.write(data);
    let hi = h1.finish() as u128;

    // Second pass: prefix with a sentinel byte so the two hashes are
    // statistically independent (different seeds via different input).
    let mut h2 = std::collections::hash_map::DefaultHasher::new();
    h2.write(&[0x5A]);
    h2.write(data);
    let lo = h2.finish() as u128;

    (hi << 64) | lo
}

pub async fn scan_files(dir: &Path, extensions: &[&str]) -> Vec<String> {
    if !tokio::fs::metadata(dir).await.map(|m| m.is_dir()).unwrap_or(false) {
        return vec![];
    }
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut visited = HashSet::new();
    if let Ok(canonical) = tokio::fs::canonicalize(dir).await {
        visited.insert(canonical);
    }
    while let Some(current_dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(current_dir).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_type = match entry.file_type().await {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if extensions.iter().any(|ext| lower.ends_with(ext)) {
                    files.push(entry.path().to_string_lossy().to_string());
                }
            } else if file_type.is_dir() {
                let canonical = tokio::fs::canonicalize(entry.path()).await.unwrap_or(entry.path());
                if visited.insert(canonical) {
                    stack.push(entry.path());
                }
            }
        }
    }
    files
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
                end = self.chars.peek().map(|&(next_idx, _)| next_idx).unwrap_or(self.s.len());
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
            (Some(ca), Some(cb)) => {
                match ca.cmp(&cb) {
                    std::cmp::Ordering::Equal => {}
                    non_eq => return non_eq,
                }
            }
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // to_absolute
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // hash_path
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // safe_delete (sync variant — tests the match logic directly)
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // compare_natural (existing)
    // -----------------------------------------------------------------------

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
