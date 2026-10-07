#[cfg(panic = "abort")]
compile_error!("The Node-API adapter requires panic=unwind for boundary reclamation");

pub use hash_interop::*;
pub use math_interop::*;
