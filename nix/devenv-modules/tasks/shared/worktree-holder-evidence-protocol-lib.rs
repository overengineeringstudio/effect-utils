//! Holder-evidence v1 types, strict wire codec, request adapter and SHA-256.
//! This library grants no census, authentication, freshness or deletion authority.
//! It uses only std and requires neither Linux interfaces nor elevated privileges.
#![forbid(unsafe_code)]

#[path = "worktree-holder-evidence-request.rs"]
pub mod request;
#[path = "worktree-holder-evidence-digest.rs"]
pub mod digest;
#[path = "worktree-holder-evidence-protocol.rs"]
pub mod protocol;

#[cfg(test)]
mod tests {
    use super::{digest, protocol};
    use std::time::{Duration, Instant};

    #[test]
    fn generated_codec_bytes_match_frozen_ten_case_fixture() {
        // Raw reviewed bytes, not a parsed or reserialized approximation.
        let expected = include_bytes!("../../../../packages/@overeng/megarepo/src/store/fixtures/worktree-holder-evidence-v1.jsonl");
        assert_eq!(expected.len(), 12745);
        assert_eq!(digest::digest(expected.to_vec(), Instant::now() + Duration::from_secs(1)).unwrap(),
            "06e42489f5e4d1664146a4e169bed0cb0f9ac5e0cb1c360b7d2cc0991c0b5bb7");
        let fixtures = protocol::codec_fixtures().unwrap();
        assert_eq!(fixtures.len(), 10);
        let mut actual = Vec::new();
        for fixture in fixtures {
            actual.extend_from_slice(&fixture);
            actual.push(b'\n');
        }
        assert_eq!(actual.as_slice(), expected);
    }
}
