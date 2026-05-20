use std::path::{Path, PathBuf};

/// Ubah path relatif menjadi absolut berdasarkan current working directory.
pub fn to_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub fn ensure_dir(dir: &Path) -> Result<(), std::io::Error> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

pub fn safe_delete(file: &Path) -> Result<(), std::io::Error> {
    if file.exists() {
        std::fs::remove_file(file)?;
    }
    Ok(())
}

pub fn scan_files(dir: &Path, extensions: &[&str]) -> Vec<String> {
    if !dir.is_dir() {
        eprintln!("[scan_files] BUKAN direktori: {:?}", dir);
        return vec![];
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("[scan_files] Gagal membaca direktori {:?}: {}", dir, e);
            return vec![];
        }
    };

    let mut files = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let file_type = match entry.file_type() {
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

    eprintln!(
        "[scan_files] Direktori: {:?}, ekstensi: {:?}, ditemukan {} file: {:?}",
        dir,
        extensions,
        files.len(),
        files
    );

    files
}
