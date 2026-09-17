//! RootRay native core.
//!
//! This crate owns everything the desktop shell delegates to native code:
//! project detection, the managed dev-server lifecycle, loopback URL
//! detection, external-editor discovery, filesystem boundaries and local
//! settings. It deliberately has **no Tauri dependency** so the logic stays
//! unit-testable; the `src-tauri` crate is a thin command layer on top.

pub mod app;
pub mod editor;
pub mod error;
pub mod filesystem;
pub mod html_instrument;
pub mod inspector;
pub mod launcher;
pub mod process;
pub mod project;
pub mod settings;
pub mod state;
pub mod static_server;

pub use app::AppCore;
pub use error::{CommandError, CoreError};
