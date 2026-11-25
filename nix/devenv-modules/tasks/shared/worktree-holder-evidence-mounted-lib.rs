//! Inactive native mounted-root and candidate-membership layer.
//! Reuses the protocol and kernel libraries; no server, privilege or activation.
pub use holder_evidence_protocol::{digest, protocol, request};
pub use worktree_holder_proc::{linux, objects};

#[path = "worktree-holder-evidence-namespace.rs"]
pub mod namespace;

#[path = "worktree-holder-evidence-inventory.rs"]
mod inventory;
#[path = "worktree-holder-evidence-mounts.rs"]
pub mod mounts;
#[path = "worktree-holder-evidence-candidates.rs"]
pub mod candidates;
