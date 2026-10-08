//! Byte-engine exports; tree discovery and canonical manifests remain Effect-owned.
use content_address_contract::{
    ContentAddressContract1, ContentDescriptor, ContentDigest, MediaType,
};
use content_address_core::{Digest, EntryKind, TreeHasher};
use effect_rust::{host, Bytes};

/// Preorder records supplied by the host; `path` is root-relative (`.` for root).
#[effect_rust::contract]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Entry {
    Directory {
        path: String,
        mode: u32,
    },
    Symlink {
        path: String,
        mode: u32,
        target: String,
    },
    File {
        path: String,
        mode: u32,
        read_path: String,
    },
}

#[derive(Debug, serde::Serialize, serde::Deserialize, effect_rust::ExportError)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ContentAddressError {
    Read { path: String, message: String },
    InvalidMediaType { message: String },
}

impl std::fmt::Display for ContentAddressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, message } => write!(formatter, "{path}: {message}"),
            Self::InvalidMediaType { message } => {
                write!(formatter, "invalid media type: {message}")
            }
        }
    }
}

impl std::error::Error for ContentAddressError {}

#[effect_rust::export]
pub fn hash(bytes: Bytes) -> Digest {
    content_address_core::hash(&bytes)
}

#[effect_rust::export(input_stream, returns = "Digest")]
pub fn hasher() -> content_address_core::Hasher {
    content_address_core::Hasher::new()
}

/// Reads file bytes only; record ordering, metadata and link resolution belong to the host.
#[effect_rust::export(async, name = "hashTree")]
pub async fn hash_tree(
    source: host::Source<host::Abortable>,
    records: Vec<Entry>,
) -> Result<Digest, ContentAddressError> {
    let mut hasher = TreeHasher::new();
    for entry in records {
        match entry {
            Entry::Directory { path, mode } => {
                hasher.begin_entry(&path, mode, EntryKind::Directory)
            }
            Entry::Symlink { path, mode, target } => {
                hasher.begin_entry(&path, mode, EntryKind::Symlink);
                hasher.update_symlink_target(&target);
            }
            Entry::File {
                path,
                mode,
                read_path,
            } => {
                hasher.begin_entry(&path, mode, EntryKind::File);
                let mut offset = 0;
                loop {
                    let bytes = source
                        .read_range(&read_path, offset, 256 * 1024)
                        .await
                        .map_err(|error| ContentAddressError::Read {
                            path: read_path.clone(),
                            message: error.to_string(),
                        })?;
                    if bytes.is_empty() {
                        break;
                    }
                    hasher.update(&bytes);
                    offset += bytes.len() as u64;
                    source
                        .yield_now()
                        .await
                        .map_err(|error| ContentAddressError::Read {
                            path: read_path.clone(),
                            message: error.to_string(),
                        })?;
                }
            }
        }
    }
    Ok(hasher.finish())
}

#[effect_rust::export]
pub fn describe(
    bytes: Bytes,
    media_type: String,
) -> Result<ContentDescriptor, ContentAddressError> {
    let media_type =
        MediaType::new(media_type).map_err(|error| ContentAddressError::InvalidMediaType {
            message: error.to_string(),
        })?;
    Ok(ContentDescriptor {
        tag: ContentAddressContract1::ContentDescriptor,
        digest: ContentDigest::new(content_address_core::hash(&bytes).to_string())
            .expect("core digest satisfies the generated descriptor contract"),
        byte_length: u64::try_from(bytes.len())
            .expect("allocated byte lengths fit u64")
            .try_into()
            .expect("allocated byte lengths fit the generated safe-integer contract"),
        media_type,
        codec: None,
        schema_version: None,
    })
}

/// The generated serde decoder validates every field before this roundtrip.
#[effect_rust::export(name = "validateDescriptor")]
pub fn validate_descriptor(descriptor: ContentDescriptor) -> ContentDescriptor {
    descriptor
}
