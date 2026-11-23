//! Read-only Linux kernel census primitives, independent of wire and policy layers.
//!
//! Extracted from the reviewed holder-evidence kernel boundary. Production proc
//! lookups are fixed to /proc; no environment or alternate-root hook exists.
//! Consumers retain ProcessScope and References through their own membership,
//! mount-source and policy rechecks. An io::Error is UNKNOWN, never absence.
//! The observing helper's own source-attested descriptor role belongs to the
//! assembler: use Held/numbers/mapping_names there, not collect_resources, whose
//! descriptor inventory deliberately has no self-exemption.
//!
//! Assembly cutover: replace the old linux kernel functions and objects helpers
//! with these modules; keep socket functions in the transport layer. Replace
//! client Process/process/uids with process imports. Replace census scope, Held,
//! namespace/resource enumeration and no-mm helpers with scopes imports; retain
//! candidate membership, mounted-root and management-role logic above this seam.
#![cfg(target_os = "linux")]

#[path = "worktree-holder-proc-linux.rs"]
pub mod linux;
#[path = "worktree-holder-proc-objects.rs"]
pub mod objects;
#[path = "worktree-holder-proc-process.rs"]
pub mod process;
#[path = "worktree-holder-proc-scopes.rs"]
pub mod scopes;

#[cfg(test)]
#[path = "worktree-holder-proc-tests.rs"]
mod tests;
