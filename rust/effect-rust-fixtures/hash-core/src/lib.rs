#![forbid(unsafe_code)]

use sha2::{Digest, Sha256};

/// SHA-256 encoded as lowercase hexadecimal, independent of the JS adapter.
#[must_use]
pub fn sha256_hex(input: &[u8]) -> String {
    Hasher::from_bytes(input).finish()
}

/// Incremental hashing; the core never depends on a host or an FFI type.
#[derive(Default)]
pub struct Hasher(Sha256);

impl Hasher {
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut hasher = Self::default();
        hasher.update(bytes);
        hasher
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    #[must_use]
    pub fn finish(self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let digest = self.0.finalize();
        let mut output = String::with_capacity(64);
        for byte in digest {
            output.push(char::from(HEX[usize::from(byte >> 4)]));
            output.push(char::from(HEX[usize::from(byte & 15)]));
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn sha256_abc_known_answer() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
