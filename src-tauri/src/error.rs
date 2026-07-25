use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("FFmpeg error: {0}")]
    Ffmpeg(String),

    #[error("No audio files found")]
    NoAudio,

    #[error("No video files found")]
    NoVideo,

    #[error("Invalid duration for file: {0}")]
    InvalidDuration(String),

    #[error("Pipeline error: {0}")]
    Pipeline(String),

    #[error("Render cancelled: {0}")]
    Cancelled(String),

    #[error("Render paused: {0}")]
    Paused(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_io_display() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err = AppError::Io(io_err);
        assert!(err.to_string().contains("I/O error"));
        assert!(err.to_string().contains("file not found"));
    }

    #[test]
    fn test_error_ffmpeg_display() {
        let err = AppError::Ffmpeg("ffmpeg exited with code 1".into());
        assert_eq!(err.to_string(), "FFmpeg error: ffmpeg exited with code 1");
    }

    #[test]
    fn test_error_no_audio() {
        let err = AppError::NoAudio;
        assert_eq!(err.to_string(), "No audio files found");
    }

    #[test]
    fn test_error_no_video() {
        let err = AppError::NoVideo;
        assert_eq!(err.to_string(), "No video files found");
    }

    #[test]
    fn test_error_invalid_duration() {
        let err = AppError::InvalidDuration("video.mp4".into());
        assert_eq!(err.to_string(), "Invalid duration for file: video.mp4");
    }

    #[test]
    fn test_error_pipeline() {
        let err = AppError::Pipeline("something went wrong".into());
        assert_eq!(err.to_string(), "Pipeline error: something went wrong");
    }

    #[test]
    fn test_error_cancelled() {
        let err = AppError::Cancelled("by user".into());
        assert_eq!(err.to_string(), "Render cancelled: by user");
    }

    #[test]
    fn test_error_paused() {
        let err = AppError::Paused("by user".into());
        assert_eq!(err.to_string(), "Render paused: by user");
    }
}
