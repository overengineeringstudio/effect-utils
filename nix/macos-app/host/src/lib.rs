//! Narrow macOS security primitives shared by generic and product-native hosts.
//! Audit tokens must come from the kernel transport, never from request data.
mod requirement;
pub mod endpoint;
pub use requirement::{AuditToken, AuthenticatedPeer, CompiledRequirement, PeerPolicy, authenticate_peer, authenticate_token};

#[derive(Debug)]
pub enum SecurityError {
    InvalidInput(&'static str),
    Security { operation: &'static str, status: i32 },
    Unavailable(&'static str),
    UnauthorizedUid,
    StaleToken(std::io::Error),
    EndpointPolicy(&'static str),
    Io(std::io::Error),
}
impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(s) | Self::Unavailable(s) | Self::EndpointPolicy(s) => f.write_str(s),
            Self::Security { operation, status } => write!(f, "{operation}: Security status {status}"),
            Self::UnauthorizedUid => f.write_str("Caller effective and real UIDs must both be authorized"),
            Self::StaleToken(e) => write!(f, "Audit token is no longer current: {e}"),
            Self::Io(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for SecurityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self { Self::Io(e) | Self::StaleToken(e) => Some(e), _ => None }
    }
}
impl From<std::io::Error> for SecurityError { fn from(e: std::io::Error) -> Self { Self::Io(e) } }
