use std::path::Path;

/// Supported video file extensions — shared with source_scanner and the
/// frontend config (`src/core/config.ts`) for consistent file filtering.
/// IMPORTANT: keep in sync with the TypeScript VIDEO_EXTENSIONS.
pub const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".wmv",
];

/// Supported audio file extensions — shared with source_scanner and the
/// frontend config (`src/core/config.ts`) for consistent file filtering.
/// IMPORTANT: keep in sync with the TypeScript AUDIO_EXTENSIONS.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma",
];

/// Rough estimate of the total bytes all jobs will write to disk.
///
/// This is deliberately a simple estimate (video bitrate is taken as the
/// configured maxrate, audio as a typical 192 kbps AAC) used only for a
/// non-fatal disk-space warning, not for hard limits.
pub fn estimate_total_output_bytes(
    num_jobs: usize,
    maxrate_k: u32,
    avg_song_sec: f64,
    songs_per_playlist: usize,
    min_duration_sec: u64,
    loop_count: Option<usize>,
) -> u64 {
    let single_loop_sec = avg_song_sec * songs_per_playlist as f64;
    let per_job_sec = if let Some(n) = loop_count {
        single_loop_sec * n as f64
    } else {
        single_loop_sec.max(min_duration_sec as f64)
    };
    let video_kbps = maxrate_k as f64;
    let audio_kbps = 192.0;
    // 1 kbps = 1000 bits/s = 125 bytes/s.
    let bytes_per_sec = (video_kbps + audio_kbps) * 125.0;
    (bytes_per_sec * per_job_sec * num_jobs as f64) as u64
}

/// Human-readable byte count (B / KB / MB / GB / TB).
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut val = bytes as f64;
    let mut i = 0;
    while val >= 1024.0 && i < UNITS.len() - 1 {
        val /= 1024.0;
        i += 1;
    }
    format!("{:.1} {}", val, UNITS[i])
}

pub fn parse_bitrate_to_kbps(value: &str) -> Option<u32> {
    let normalized = value.trim().to_ascii_lowercase();
    let number = normalized.strip_suffix('k').unwrap_or(&normalized);
    number.parse::<u32>().ok()
}

pub fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let stem = Path::new(&sanitized)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // Guard against completely sanitized names (e.g. all invalid chars
    // replaced by underscores) that collapse to an empty stem — an empty
    // filename causes OS-level errors and bypasses the reserved-name check
    // below.
    if stem.is_empty() {
        return "unnamed".to_string();
    }
    let reserved = [
        "CON", "NUL", "PRN", "AUX", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&stem.to_ascii_uppercase().as_str()) {
        format!("_{}", sanitized)
    } else {
        sanitized
    }
}

/// Returns the free space (bytes) on the filesystem that hosts `path`, or 0 if
/// it cannot be determined.
pub fn available_space_for(path: &std::path::Path) -> u64 {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let canon_norm = canon
        .to_string_lossy()
        .to_ascii_lowercase()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let mut best: Option<(String, u64)> = None;
    for disk in disks.list() {
        let mp_norm = disk
            .mount_point()
            .to_string_lossy()
            .to_ascii_lowercase()
            .trim_end_matches(['\\', '/'])
            .to_string();
        if canon_norm == mp_norm
            || canon_norm.starts_with(&format!("{}\\", mp_norm))
            || canon_norm.starts_with(&format!("{}/", mp_norm))
        {
            let is_better = match &best {
                Some((best_mp, _)) => mp_norm.len() > best_mp.len(),
                None => true,
            };
            if is_better {
                best = Some((mp_norm, disk.available_space()));
            }
        }
    }
    best.map(|(_, space)| space).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_single_job_with_loop_count() {
        let bytes = estimate_total_output_bytes(1, 4000, 30.0, 9, 3600, Some(2));
        assert_eq!(bytes, 282960000);
    }

    #[test]
    fn test_estimate_single_job_min_duration() {
        let bytes = estimate_total_output_bytes(1, 4000, 10.0, 3, 60, None);
        assert_eq!(bytes, 31440000);
    }

    #[test]
    fn test_estimate_multiple_jobs() {
        let bytes = estimate_total_output_bytes(3, 5000, 30.0, 5, 300, None);
        assert_eq!(bytes, 584100000);
    }

    #[test]
    fn test_human_bytes_bytes() {
        assert_eq!(human_bytes(500), "500.0 B");
    }

    #[test]
    fn test_human_bytes_kb() {
        assert_eq!(human_bytes(2048), "2.0 KB");
    }

    #[test]
    fn test_human_bytes_mb() {
        assert_eq!(human_bytes(5_242_880), "5.0 MB");
    }

    #[test]
    fn test_human_bytes_gb() {
        assert_eq!(human_bytes(10_737_418_240), "10.0 GB");
    }

    #[test]
    fn test_human_bytes_tb() {
        assert_eq!(human_bytes(1_099_511_627_776), "1.0 TB");
    }

    #[test]
    fn test_human_bytes_zero() {
        assert_eq!(human_bytes(0), "0.0 B");
    }

    #[test]
    fn test_human_bytes_exact_boundary() {
        assert_eq!(human_bytes(1023), "1023.0 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
    }

    #[test]
    fn test_parse_bitrate_with_k_suffix() {
        assert_eq!(parse_bitrate_to_kbps("4000k"), Some(4000));
    }

    #[test]
    fn test_parse_bitrate_without_suffix() {
        assert_eq!(parse_bitrate_to_kbps("2000"), Some(2000));
    }

    #[test]
    fn test_parse_bitrate_case_insensitive() {
        assert_eq!(parse_bitrate_to_kbps("4000K"), Some(4000));
    }

    #[test]
    fn test_parse_bitrate_invalid() {
        assert_eq!(parse_bitrate_to_kbps("abc"), None);
    }

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename_component("My Channel"), "My Channel");
    }

    #[test]
    fn test_sanitize_filename_special_chars() {
        assert_eq!(sanitize_filename_component("My:Channel/Name"), "My_Channel_Name");
    }

    #[test]
    fn test_sanitize_filename_control_chars() {
        assert_eq!(sanitize_filename_component("Test\x00Name"), "TestName");
    }

    #[test]
    fn test_sanitize_filename_trim_dots() {
        assert_eq!(sanitize_filename_component(".My Channel."), "My Channel");
    }

    #[test]
    fn test_sanitize_filename_reserved_windows() {
        let result = sanitize_filename_component("CON");
        assert!(result.starts_with('_'));
        assert!(result.contains("CON"));
    }
}
