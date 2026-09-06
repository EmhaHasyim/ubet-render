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
