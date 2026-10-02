#![forbid(unsafe_code)]

use sha2::{Digest as _, Sha256};
use std::{fmt, str::FromStr};

/// SHA-256 bytes with the canonical `sha256:<64 lowercase hex>` text identity.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[cfg_attr(feature = "contract", derive(serde::Deserialize))]
#[cfg_attr(feature = "contract", serde(try_from = "String"))]
pub struct Digest(pub [u8; 32]);

impl fmt::Display for Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut text = [0u8; 71];
        text[..7].copy_from_slice(b"sha256:");
        for (byte, pair) in self.0.iter().zip(text[7..].chunks_exact_mut(2)) {
            pair[0] = HEX[usize::from(byte >> 4)];
            pair[1] = HEX[usize::from(byte & 15)];
        }
        formatter.write_str(std::str::from_utf8(&text).expect("digest text is ASCII"))
    }
}

/// The input was not a canonical SHA-256 identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseDigestError {
    InvalidPrefix,
    InvalidLength,
    /// Byte offset within the hexadecimal suffix.
    InvalidHex {
        index: usize,
    },
}

impl fmt::Display for ParseDigestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPrefix => formatter.write_str("digest must start with sha256:"),
            Self::InvalidLength => formatter.write_str("digest must contain exactly 64 hex bytes"),
            Self::InvalidHex { index } => {
                write!(formatter, "digest requires lowercase hex at byte {index}")
            }
        }
    }
}

impl std::error::Error for ParseDigestError {}

impl FromStr for Digest {
    type Err = ParseDigestError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let hex = value
            .strip_prefix("sha256:")
            .ok_or(ParseDigestError::InvalidPrefix)?;
        if hex.len() != 64 {
            return Err(ParseDigestError::InvalidLength);
        }
        let mut bytes = [0u8; 32];
        for (index, byte) in hex.bytes().enumerate() {
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => return Err(ParseDigestError::InvalidHex { index }),
            };
            bytes[index / 2] |= digit << (if index % 2 == 0 { 4 } else { 0 });
        }
        Ok(Self(bytes))
    }
}

#[cfg(feature = "contract")]
impl TryFrom<String> for Digest {
    type Error = ParseDigestError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

// Serialize directly through Display rather than allocating a temporary String.
#[cfg(feature = "contract")]
impl serde::Serialize for Digest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

// The backing byte array is not the wire type. Include the same portable-pattern
// vocabulary as effect-rust string brands without coupling this core to an FFI.
#[cfg(feature = "contract")]
impl schemars::JsonSchema for Digest {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Digest".into()
    }

    fn schema_id() -> std::borrow::Cow<'static, str> {
        concat!(module_path!(), "::Digest").into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "minLength": 71,
            "maxLength": 71,
            "pattern": "^sha256:[0-9a-f]{64}$",
            "x-effect-rust-pattern": "^sha256:[0-9a-f]{64}$",
            "x-effect-rust-pattern-flags": "u"
        })
    }
}

/// SHA-256 of a byte slice, independent of filesystems and wire contracts.
#[must_use]
pub fn hash(bytes: &[u8]) -> Digest {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finish()
}

/// Incremental SHA-256; finishing consumes the accumulator.
#[derive(Default)]
pub struct Hasher(Sha256);

impl Hasher {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    #[must_use]
    pub fn finish(self) -> Digest {
        Digest(self.0.finalize().into())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryKind {
    Directory,
    Symlink,
    File,
}

/// The mode-sensitive tree protocol used by Buck input-root fingerprints.
///
/// Supply entries in preorder, starting with the root path `.`. The caller owns
/// traversal: directory children must be ordered by UTF-16 code units, matching
/// JavaScript's default string sort. Paths and link targets are UTF-8 text, framed
/// by their big-endian u32 byte length. File bytes are deliberately unframed.
/// This accumulator neither accesses the filesystem nor reorders records.
#[derive(Default)]
pub struct TreeHasher(Hasher);

impl TreeHasher {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Append path, decimal permission bits, and kind, each as framed text.
    ///
    /// # Panics
    /// Panics if the path is longer than u32::MAX UTF-8 bytes.
    pub fn begin_entry(&mut self, path: &str, mode: u32, kind: EntryKind) {
        self.frame_text(path);
        // Masked modes range from 0 through 4095; decimal formatting fits on stack.
        let mut mode = mode & 0o7777;
        let mut decimal = [0u8; 4];
        let mut start = decimal.len();
        loop {
            start -= 1;
            decimal[start] = b'0' + u8::try_from(mode % 10).expect("decimal digit fits u8");
            mode /= 10;
            if mode == 0 {
                break;
            }
        }
        self.frame_text(std::str::from_utf8(&decimal[start..]).expect("decimal mode is ASCII"));
        self.frame_text(match kind {
            EntryKind::Directory => "directory",
            EntryKind::Symlink => "symlink",
            EntryKind::File => "file",
        });
    }

    /// Append a symlink's complete target after its entry header.
    ///
    /// # Panics
    /// Panics if the target is longer than u32::MAX UTF-8 bytes.
    pub fn update_symlink_target(&mut self, target: &str) {
        self.frame_text(target);
    }

    /// Append a file chunk after its entry header, with no additional framing.
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    #[must_use]
    pub fn finish(self) -> Digest {
        self.0.finish()
    }

    fn frame_text(&mut self, text: &str) {
        let length = u32::try_from(text.len()).expect("tree text exceeds u32 byte length");
        self.0.update(&length.to_be_bytes());
        self.0.update(text.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::{Digest, EntryKind, Hasher, ParseDigestError, TreeHasher, hash};

    #[test]
    fn digest_parser_accepts_only_canonical_text() {
        let text = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let digest: Digest = text.parse().unwrap();
        assert_eq!(digest.to_string(), text);
        assert_eq!(
            digest.0[..8],
            [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]
        );
        assert_eq!(
            "sha256:".parse::<Digest>(),
            Err(ParseDigestError::InvalidLength)
        );
        assert_eq!(
            text[7..].parse::<Digest>(),
            Err(ParseDigestError::InvalidPrefix)
        );
        for invalid in [
            text.to_uppercase(),
            format!("{text}0"),
            text[..70].to_owned(),
            format!("{text}\n"),
            text.replace('a', "A"),
            text.replace('f', "g"),
            format!("sha256:{}é", "0".repeat(62)),
            format!(" {text}"),
        ] {
            assert!(invalid.parse::<Digest>().is_err(), "accepted {invalid:?}");
        }
        for byte in [0u8, 255] {
            let digest = Digest([byte; 32]);
            assert_eq!(digest.to_string().parse::<Digest>().unwrap(), digest);
        }
    }

    #[test]
    fn one_shot_and_incremental_match_sha256_known_answers() {
        assert_eq!(
            hash(b"").to_string(),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hash(b"abc").to_string(),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let bytes: Vec<_> = (0..=255).cycle().take(1025).collect();
        for chunk_size in [1, 3, 63, 64, 65, 128, 1025] {
            let mut incremental = Hasher::new();
            incremental.update(b"");
            for chunk in bytes.chunks(chunk_size) {
                incremental.update(chunk);
            }
            assert_eq!(incremental.finish(), hash(&bytes));
        }
    }

    fn mixed_tree(mode: u32, target: &str) -> Digest {
        let mut tree = TreeHasher::new();
        tree.begin_entry(".", 0o40755, EntryKind::Directory);
        tree.begin_entry("é", mode, EntryKind::File);
        tree.update(b"\0a");
        tree.update(b"");
        tree.update(b"bc\xff");
        tree.begin_entry("link", 0o120777, EntryKind::Symlink);
        tree.update_symlink_target(target);
        tree.finish()
    }

    #[test]
    fn tree_frames_utf8_text_but_not_file_chunks_and_masks_modes() {
        assert_eq!(
            mixed_tree(0o100640, "é").to_string(),
            "sha256:9b5fbcba1035afe570d332c35351338657d51979d9084cf64ed6c7e21f5fed1d"
        );
        assert_eq!(mixed_tree(0o100640, "é"), mixed_tree(0o640, "é"));
        assert_eq!(
            mixed_tree(0o600, "é").to_string(),
            "sha256:f500c687999569dcc2428a983e53df0ce66355dfcab9696a5a86cb2ecca9ceee"
        );
        assert_eq!(
            mixed_tree(0o640, "./é").to_string(),
            "sha256:eeeae82c1dbc6716ce8c7bf7f72381c7c0f1105f0cc5930ce1844e65eee06799"
        );
    }

    #[test]
    fn tree_root_and_text_boundaries_have_stable_identities() {
        let mut root = TreeHasher::new();
        root.begin_entry(".", 0o755, EntryKind::Directory);
        assert_eq!(
            root.finish().to_string(),
            "sha256:35485e4994857cef0139e16f31b06b018ed0e4fe739ec1a10763b11cffd778c4"
        );
        for (path, target, expected) in [
            (
                "a",
                "bc",
                "sha256:bdc4b234dfb3ccf05d830441465c68776d58c3984b77fa31872ef442810d6e6b",
            ),
            (
                "ab",
                "c",
                "sha256:f3efea16182b7031fc76d6ac74a641e57fca893f342f950faae72e86487a8c21",
            ),
        ] {
            let mut tree = TreeHasher::new();
            tree.begin_entry(".", 0o755, EntryKind::Directory);
            tree.begin_entry(path, 0o777, EntryKind::Symlink);
            tree.update_symlink_target(target);
            assert_eq!(tree.finish().to_string(), expected);
        }
    }

    #[test]
    fn tree_zero_and_maximum_modes_preserve_entry_kind() {
        for (kind, expected) in [
            (
                EntryKind::File,
                "sha256:0cdcc62a9a9d8e1ad301dd509d904a989d5f9a02d1a7528517c13648c0257652",
            ),
            (
                EntryKind::Symlink,
                "sha256:f2e974529669a6ec16ae28a10da8fd24b254109086c1879bb0bfe2d26bc798b2",
            ),
        ] {
            let mut tree = TreeHasher::new();
            tree.begin_entry(".", 0o7777, EntryKind::Directory);
            tree.begin_entry("empty", 0, kind);
            if kind == EntryKind::Symlink {
                tree.update_symlink_target("");
            }
            assert_eq!(tree.finish().to_string(), expected);
        }
    }

    #[test]
    fn tree_preserves_supplied_utf16_preorder_without_utf8_resorting() {
        // UTF-8/Rust string order puts U+E000 first; JS UTF-16 puts U+10000 first.
        let mut names = ["\u{e000}", "\u{10000}"];
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let hash_order = |names: &[&str]| {
            let mut tree = TreeHasher::new();
            tree.begin_entry(".", 0o755, EntryKind::Directory);
            for name in names {
                tree.begin_entry(name, 0o644, EntryKind::File);
                tree.update(if *name == "\u{10000}" {
                    b"supplementary"
                } else {
                    b"bmp"
                });
            }
            tree.finish().to_string()
        };
        assert_eq!(
            hash_order(&names),
            "sha256:a966de3d60eb11d33c0f1137db8596eac5f9b871b360824c98afdb4342ce6ebb"
        );
        names.reverse();
        assert_eq!(
            hash_order(&names),
            "sha256:0523e69d266f6fad36fcc3a58daae85014529e452a7e9231ee7da1ef3d8db509"
        );
    }

    #[cfg(feature = "contract")]
    #[test]
    fn digest_wire_is_a_validated_string_not_a_byte_array() {
        let digest = hash(b"abc");
        let json = serde_json::to_string(&digest).unwrap();
        assert_eq!(json, format!("\"{digest}\""));
        assert_eq!(serde_json::from_str::<Digest>(&json).unwrap(), digest);
        for invalid in [
            json.replace('a', "A"),
            "\"sha256:00\"".to_owned(),
            serde_json::to_string(&digest.0).unwrap(),
        ] {
            assert!(serde_json::from_str::<Digest>(&invalid).is_err());
        }
    }
}
