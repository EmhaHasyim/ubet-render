use std::path::{Path, PathBuf};

pub fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub async fn ensure_dir(dir: &Path) -> Result<(), std::io::Error> {
    if !tokio::fs::try_exists(dir).await.unwrap_or(false) {
        tokio::fs::create_dir_all(dir).await?;
    }
    Ok(())
}

pub async fn safe_delete(file: &Path) -> Result<(), std::io::Error> {
    if tokio::fs::try_exists(file).await.unwrap_or(false) {
        tokio::fs::remove_file(file).await?;
    }
    Ok(())
}

pub fn hash_fnv1a(data: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub async fn scan_files(dir: &Path, extensions: &[&str]) -> Vec<String> {
    if !tokio::fs::metadata(dir).await.map(|m| m.is_dir()).unwrap_or(false) {
        return vec![];
    }
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
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
            if file_type.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                if extensions.iter().any(|ext| lower.ends_with(ext)) {
                    files.push(entry.path().to_string_lossy().to_string());
                }
            } else if file_type.is_dir() {
                stack.push(entry.path());
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
            (Chunk::Str(s1), Chunk::Str(s2)) => cmp_str(s1, s2),
        }
    }
}

impl PartialOrd for Chunk<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn cmp_str(s1: &str, s2: &str) -> std::cmp::Ordering {
    let mut chars1 = s1.chars().flat_map(|c| c.to_lowercase());
    let mut chars2 = s2.chars().flat_map(|c| c.to_lowercase());

    loop {
        match (chars1.next(), chars2.next()) {
            (Some(c1), Some(c2)) => {
                match c1.cmp(&c2) {
                    std::cmp::Ordering::Equal => {}
                    non_eq => return non_eq,
                }
            }
            (None, None) => break,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
        }
    }

    match s1.len().cmp(&s2.len()) {
        std::cmp::Ordering::Equal => s1.cmp(s2),
        non_eq => non_eq,
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
            if let Ok(num) = slice.parse::<u128>() {
                Some(Chunk::Num(num, slice))
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

