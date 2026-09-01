//! Validation facade. Implementations live in focused submodules while this
//! module preserves the existing `crate::validation::*` API.

mod config;
pub(crate) mod limits;
mod path;

pub(crate) use config::validate_resumed_jobs;
pub use config::{validate_app_config, validate_override_config};
pub(crate) use limits::{MAX_RESUME_STATE_BYTES, MAX_SOURCE_FILES};
pub use path::resolve_and_validate_path;
pub(crate) use path::{is_system_protected_path, sanitize_path};

#[cfg(test)]
mod tests {
    use crate::pipeline::estimator::{AUDIO_EXTENSIONS, VIDEO_EXTENSIONS};

    const EXPECTED_VIDEO_EXTENSIONS_RUST: &[&str] =
        &[".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".wmv"];
    const EXPECTED_AUDIO_EXTENSIONS_RUST: &[&str] = &[
        ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".opus", ".aiff", ".aif",
    ];

    #[test]
    fn test_video_extensions_match_canonical_list() {
        assert_eq!(VIDEO_EXTENSIONS, EXPECTED_VIDEO_EXTENSIONS_RUST);
    }

    #[test]
    fn test_audio_extensions_match_canonical_list() {
        assert_eq!(AUDIO_EXTENSIONS, EXPECTED_AUDIO_EXTENSIONS_RUST);
    }
}
