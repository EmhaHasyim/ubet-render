//! Validation facade. Implementations live in focused submodules while this
//! module preserves the existing `crate::validation::*` API.

mod config;
pub mod limits;
mod path;

pub(crate) use config::validate_resumed_jobs;
pub use config::{validate_app_config, validate_override_config};
pub(crate) use limits::{MAX_RESUME_STATE_BYTES, MAX_SOURCE_FILES};
pub use path::resolve_and_validate_path;
pub(crate) use path::{is_system_protected_path, sanitize_path};
