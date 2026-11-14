//! Target identities are independent of display order. The reserved identity
//! carries run-wide network context rather than any target's probe history.
pub type TargetId = usize;
pub const GLOBAL_ID: TargetId = usize::MAX;

pub struct Target {
    pub id: TargetId,
    pub name: String,
    pub address: Option<std::net::IpAddr>,
}
