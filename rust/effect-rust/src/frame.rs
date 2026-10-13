//! Borsh bulk frames: `[contract_id: u32 LE][version: u16 LE][payload]`.
use crate::Bytes;
use borsh::{BorshDeserialize, BorshSerialize};
use std::fmt;
use std::io;

pub const HEADER_LEN: usize = 6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub contract_id: u32,
    pub version: u16,
}

impl Header {
    /// # Errors
    /// Rejects inputs too short to carry the mandatory header.
    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        let header = bytes.get(..HEADER_LEN).ok_or(FrameError::HeaderTooShort {
            actual: bytes.len(),
        })?;
        Ok(Self {
            contract_id: u32::from_le_bytes([header[0], header[1], header[2], header[3]]),
            version: u16::from_le_bytes([header[4], header[5]]),
        })
    }

    #[must_use]
    pub fn encode(self) -> [u8; HEADER_LEN] {
        let id = self.contract_id.to_le_bytes();
        let version = self.version.to_le_bytes();
        [id[0], id[1], id[2], id[3], version[0], version[1]]
    }
}

#[derive(Debug)]
pub enum FrameError {
    HeaderTooShort { actual: usize },
    ContractMismatch { expected: u32, actual: u32 },
    VersionMismatch { expected: u16, actual: u16 },
    Payload(io::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HeaderTooShort { actual } => write!(
                formatter,
                "frame header requires {HEADER_LEN} bytes, got {actual}"
            ),
            Self::ContractMismatch { expected, actual } => write!(
                formatter,
                "frame contract mismatch: expected {expected}, got {actual}"
            ),
            Self::VersionMismatch { expected, actual } => write!(
                formatter,
                "frame version mismatch: expected {expected}, got {actual}"
            ),
            Self::Payload(error) => write!(formatter, "invalid Borsh frame payload: {error}"),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Payload(error) => Some(error),
            _ => None,
        }
    }
}

/// Serializes directly into the framed output, without an intermediate payload.
/// # Errors
/// Returns the underlying Borsh serialization failure.
pub fn encode<T: BorshSerialize + ?Sized>(
    value: &T,
    contract_id: u32,
    version: u16,
) -> Result<Bytes, FrameError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(
        &Header {
            contract_id,
            version,
        }
        .encode(),
    );
    value.serialize(&mut bytes).map_err(FrameError::Payload)?;
    Ok(bytes)
}

/// Validates the header before decoding the payload. Trailing bytes are rejected.
/// # Errors
/// Rejects short headers, wrong contracts/versions, and invalid Borsh payloads.
pub fn decode<T: BorshDeserialize>(
    bytes: &[u8],
    contract_id: u32,
    version: u16,
) -> Result<T, FrameError> {
    let header = Header::decode(bytes)?;
    if header.contract_id != contract_id {
        return Err(FrameError::ContractMismatch {
            expected: contract_id,
            actual: header.contract_id,
        });
    }
    if header.version != version {
        return Err(FrameError::VersionMismatch {
            expected: version,
            actual: header.version,
        });
    }
    T::try_from_slice(&bytes[HEADER_LEN..]).map_err(FrameError::Payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Eq, PartialEq, BorshSerialize, BorshDeserialize)]
    struct Row {
        count: u64,
        enabled: bool,
    }

    #[test]
    fn frame_has_exact_little_endian_header_and_borsh_payload() {
        let row = Row {
            count: 0x0807_0605_0403_0201,
            enabled: true,
        };
        let bytes = encode(&row, 0x0403_0201, 0x0605).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 7, 8, 1]);
        assert_eq!(decode::<Row>(&bytes, 0x0403_0201, 0x0605).unwrap(), row);
    }

    #[test]
    fn header_rejects_all_short_lengths_and_precedes_payload_validation() {
        for len in 0..HEADER_LEN {
            assert!(
                matches!(decode::<Row>(&[0; HEADER_LEN][..len], 0, 0), Err(FrameError::HeaderTooShort { actual }) if actual == len)
            );
        }
        let header = Header {
            contract_id: 42,
            version: 7,
        }
        .encode();
        assert!(matches!(
            decode::<Row>(&header, 43, 8),
            Err(FrameError::ContractMismatch {
                expected: 43,
                actual: 42
            })
        ));
        assert!(matches!(
            decode::<Row>(&header, 42, 8),
            Err(FrameError::VersionMismatch {
                expected: 8,
                actual: 7
            })
        ));
        assert!(matches!(
            decode::<Row>(&header, 42, 7),
            Err(FrameError::Payload(_))
        ));
    }

    #[test]
    fn invalid_truncated_and_trailing_payloads_are_rejected() {
        let bytes = encode(
            &Row {
                count: u64::MAX,
                enabled: false,
            },
            u32::MAX,
            u16::MAX,
        )
        .unwrap();
        assert!(matches!(
            decode::<Row>(&bytes[..bytes.len() - 1], u32::MAX, u16::MAX),
            Err(FrameError::Payload(_))
        ));
        let mut invalid = bytes.clone();
        *invalid.last_mut().unwrap() = 2;
        assert!(matches!(
            decode::<Row>(&invalid, u32::MAX, u16::MAX),
            Err(FrameError::Payload(_))
        ));
        let mut trailing = bytes;
        trailing.push(0);
        assert!(matches!(
            decode::<Row>(&trailing, u32::MAX, u16::MAX),
            Err(FrameError::Payload(_))
        ));
    }
}
