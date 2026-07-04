//! Registry-agnostic hex encoding and stable content-hashing helpers.
//!
//! Extracted from `otel-scrape` so a second Rust consumer can share the W3C
//! trace-context and content-address primitives without dragging the
//! `otel_scrape` telemetry registry across the crate boundary.

use std::fmt::Write as _;
use std::io;

#[cfg(target_os = "linux")]
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// Lower-hex encode a byte slice (two hex chars per byte).
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("write to string");
    }
    out
}

/// Cryptographically-random lower-hex string of `byte_len` bytes. Never returns
/// an all-zero value (the first byte is forced to `1` in that degenerate case),
/// so callers can use it as a non-zero W3C trace/span id.
pub fn random_hex(byte_len: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|cause| io::Error::other(cause.to_string()))?;
    if bytes.iter().all(|byte| *byte == 0) {
        bytes[0] = 1;
    }
    Ok(hex(&bytes))
}

/// True when `value` is exactly `len` lower-case ASCII hex digits.
pub fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// `sha256:<hex>` digest of `bytes`.
pub fn stable_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex(&hasher.finalize()))
}

/// Length-prefixed `sha256:<hex>` digest over an ordered list of strings. The
/// length prefix + `\0` separators make the digest injective in the boundaries
/// between values, so `["a", "bc"]` and `["ab", "c"]` hash differently.
pub fn stable_hash_lines(values: &[String]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.len().to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("sha256:{}", hex(&hasher.finalize()))
}

/// Deterministic 16-hex span id derived from a pid and its observed wall clock.
/// Used by the process-observation backends to give an OS process a stable span
/// id. Falls back to a non-zero sentinel if the derived id is all zeros.
#[cfg(target_os = "linux")]
pub fn stable_process_span_id(pid: libc::pid_t, observed_wall: SystemTime) -> String {
    let observed_unix_nanos = observed_wall
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(pid.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(observed_unix_nanos.to_string().as_bytes());
    let digest = hex(&hasher.finalize());
    let span_id = &digest[..16];
    if span_id.chars().all(|char| char == '0') {
        "0000000000000001".to_owned()
    } else {
        span_id.to_owned()
    }
}
