//! Plain-Rust capabilities and wire contracts shared by generated interop adapters.
#![forbid(unsafe_code)]

#[cfg(all(feature = "napi", not(target_arch = "wasm32"), not(panic = "unwind")))]
compile_error!("the napi feature requires panic=unwind to guard native exports");

mod cancellation;
#[cfg(feature = "contract")]
pub mod contract;
pub mod frame;
pub mod host;
pub mod native;
pub mod tagged;
pub mod wire;

pub use cancellation::{CancellationToken, Cancelled, CancellationError};
#[cfg(feature = "contract")]
pub use effect_rust_macros::contract;
pub use effect_rust_macros::{export, ExportError};
pub use host::Error;
pub use wire::{Patch, TimestampMillis, ValidationError};

/// Owned bytes crossing an interop boundary. Borrowed paths use slices instead.
pub type Bytes = Vec<u8>;

/// Error wire metadata derived from the enum's authoritative serde tag.
///
/// Use `#[derive(effect_rust::ExportError)]` on internally tagged error enums.
/// The trait and derive share a name in Rust's separate type and macro namespaces.
pub trait ExportError {
    const TAG_KEY: &'static str;
}
