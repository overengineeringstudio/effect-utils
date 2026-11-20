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
    fn generated_codec_bytes_match_frozen_nine_case_fixture() {
        // Raw reviewed bytes, not a parsed or reserialized approximation.
        let expected = include_bytes!("../../../../packages/@overeng/megarepo/src/store/fixtures/worktree-holder-evidence-v1.jsonl");
        assert_eq!(expected.len(), 11393);
        assert_eq!(digest::digest(expected.to_vec(), Instant::now() + Duration::from_secs(1)).unwrap(),
            "dccf54d29201d599a2b39fb90d7ff42d84a171d17ed3c2854b4f4d8243f18606");
        let fixtures = protocol::codec_fixtures().unwrap();
        assert_eq!(fixtures.len(), 9);
        let mut actual = Vec::new();
        for fixture in fixtures {
            actual.extend_from_slice(&fixture);
            actual.push(b'\n');
        }
        assert_eq!(actual.as_slice(), expected);
    }
}
