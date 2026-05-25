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

pub async fn scan_files(dir: &Path, extensions: &[&str]) -> Vec<String> {
    if !tokio::fs::metadata(dir).await.map(|m| m.is_dir()).unwrap_or(false) {
        return vec![];
    }

    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };

    let mut files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext)) {
            files.push(entry.path().to_string_lossy().to_string());
        }
    }

    files
}
