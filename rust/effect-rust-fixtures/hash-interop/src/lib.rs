use effect_rust::{host, Bytes};

#[derive(Debug, serde::Serialize, serde::Deserialize, effect_rust::ExportError)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SourceError {
    Read { path: String, message: String },
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, message } => write!(f, "{path}: {message}"),
        }
    }
}
impl std::error::Error for SourceError {}

#[effect_rust::export(name = "sha256Hex")]
pub fn sha256_hex(input: Bytes) -> String {
    hash_core::sha256_hex(&input)
}

#[effect_rust::export(input_stream, returns = "String")]
pub fn hasher() -> hash_core::Hasher {
    hash_core::Hasher::default()
}

#[effect_rust::export(async, name = "hashAll")]
pub async fn hash_all(
    source: host::Source<host::Abortable>,
    paths: Vec<String>,
) -> Result<String, SourceError> {
    let mut hasher = hash_core::Hasher::default();
    for path in paths {
        let bytes = source
            .read(&path)
            .await
            .map_err(|error| SourceError::Read {
                path,
                message: error.to_string(),
            })?;
        hasher.update(&bytes);
    }
    Ok(hasher.finish())
}

#[effect_rust::export(async, name = "readRange")]
pub async fn read_range(
    source: host::Source<host::Abortable>,
    path: String,
    offset: u64,
    max_bytes: u32,
) -> Result<Bytes, SourceError> {
    source
        .read_range(&path, offset, max_bytes)
        .await
        .map_err(|error| SourceError::Read {
            path,
            message: error.to_string(),
        })
}

#[effect_rust::export(async, name = "hashRanges")]
pub async fn hash_ranges(
    source: host::Source<host::Abortable>,
    path: String,
    max_bytes: u32,
) -> Result<String, SourceError> {
    let mut hasher = hash_core::Hasher::default();
    let mut offset = 0_u64;
    loop {
        let bytes = source
            .read_range(&path, offset, max_bytes)
            .await
            .map_err(|error| SourceError::Read {
                path: path.clone(),
                message: error.to_string(),
            })?;
        if bytes.is_empty() {
            break;
        }
        hasher.update(&bytes);
        offset = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| SourceError::Read {
                path: path.clone(),
                message: "range offset exceeds u64".to_owned(),
            })?;
        source
            .yield_now()
            .await
            .map_err(|error| SourceError::Read {
                path: path.clone(),
                message: error.to_string(),
            })?;
    }
    Ok(hasher.finish())
}

#[effect_rust::export(borrowed, name = "borrowedChecksum")]
pub fn borrowed_checksum(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0_u32, |sum, byte| sum.wrapping_add(u32::from(*byte)))
}
