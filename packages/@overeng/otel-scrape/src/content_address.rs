//! Content-address helpers used by the Rust artifact lane.
//!
//! This module mirrors the public `context/content-address` contract for the
//! wrapper slice. The TypeScript `@overeng/content-address` package remains the
//! reusable implementation package; this Rust module is a conforming private
//! implementation until a second Rust consumer justifies a crate boundary.

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub(crate) const PROFILE_MEDIA_TYPE: &str = "application/octet-stream";
pub(crate) const MANIFEST_MEDIA_TYPE: &str = "application/json";
pub(crate) const CANONICAL_JSON_CODEC: &str = "canonical-json";

#[derive(Debug, Clone)]
pub(crate) struct ContentDescriptor {
    pub(crate) digest: String,
    pub(crate) byte_length: usize,
    pub(crate) media_type: &'static str,
    pub(crate) codec: Option<&'static str>,
    pub(crate) schema_version: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct ManifestEntry {
    pub(crate) descriptor: ContentDescriptor,
    pub(crate) logical_path: String,
    pub(crate) role: String,
}

pub(crate) fn descriptor_for_bytes(
    bytes: &[u8],
    media_type: &'static str,
    codec: Option<&'static str>,
    schema_version: Option<u64>,
) -> ContentDescriptor {
    ContentDescriptor {
        digest: stable_hash(bytes),
        byte_length: bytes.len(),
        media_type,
        codec,
        schema_version,
    }
}

pub(crate) fn cas_uri_for_digest(digest: &str) -> String {
    format!("cas:{}", object_path_for_digest(digest))
}

pub(crate) fn object_path_for_digest(digest: &str) -> String {
    let hex = digest
        .strip_prefix("sha256:")
        .expect("content-address digests use sha256:<hex>");
    format!("sha256/{}/{}", &hex[..2], &hex[2..])
}

pub(crate) fn write_object(
    root: &Path,
    descriptor: &ContentDescriptor,
    bytes: &[u8],
) -> io::Result<()> {
    write_bytes_atomic(
        &root.join(object_path_for_digest(&descriptor.digest)),
        bytes,
    )
}

pub(crate) fn write_pin(root: &Path, name: &str, manifest: &ContentDescriptor) -> io::Result<()> {
    let pin_path = pin_path(root, name)?;
    let pin_json = format!(
        "{{\"_tag\":\"ContentPin\",\"schemaVersion\":1,\"target\":{}}}\n",
        descriptor_json(manifest)
    );
    write_bytes_atomic(&pin_path, pin_json.as_bytes())
}

pub(crate) fn pin_path(root: &Path, name: &str) -> io::Result<PathBuf> {
    validate_pin_name(name)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    Ok(root.join("pins").join(name.replace('\\', "/")))
}

pub(crate) fn validate_pin_name(name: &str) -> Result<(), &'static str> {
    if name.trim().is_empty()
        || name.contains('\0')
        || Path::new(name).is_absolute()
        || name
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("pin names must be non-empty relative paths without empty or parent segments");
    }
    Ok(())
}

pub(crate) fn canonical_manifest_json(entries: &[ManifestEntry]) -> String {
    let entries = entries
        .iter()
        .map(manifest_entry_json)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"_tag\":\"ContentManifest\",\"entries\":[{entries}],\"role\":\"otel-scrape-run\",\"schemaVersion\":1}}"
    )
}

fn manifest_entry_json(entry: &ManifestEntry) -> String {
    format!(
        "{{\"descriptor\":{},\"logicalPath\":{},\"role\":{}}}",
        descriptor_json(&entry.descriptor),
        json_string(&entry.logical_path),
        json_string(&entry.role)
    )
}

fn descriptor_json(descriptor: &ContentDescriptor) -> String {
    let mut out = format!(
        "{{\"_tag\":\"ContentDescriptor\",\"byteLength\":{},",
        descriptor.byte_length
    );
    if let Some(codec) = descriptor.codec {
        write!(&mut out, "\"codec\":{},", json_string(codec)).expect("write to string");
    }
    write!(
        &mut out,
        "\"digest\":{},\"mediaType\":{}",
        json_string(&descriptor.digest),
        json_string(descriptor.media_type)
    )
    .expect("write to string");
    if let Some(schema_version) = descriptor.schema_version {
        write!(&mut out, ",\"schemaVersion\":{schema_version}").expect("write to string");
    }
    out.push('}');
    out
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}

pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temp = temp_path_for(path)?;
    if let Err(cause) = fs::write(&temp, bytes).and_then(|()| fs::rename(&temp, path)) {
        let _ = fs::remove_file(&temp);
        return Err(cause);
    }
    Ok(())
}

fn temp_path_for(path: &Path) -> io::Result<PathBuf> {
    let suffix = random_hex(8)?;
    Ok(path.with_extension(format!(
        "{}tmp-{}-{suffix}",
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default(),
        std::process::id()
    )))
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn random_hex(byte_len: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|cause| io::Error::other(cause.to_string()))?;
    if bytes.iter().all(|byte| *byte == 0) {
        bytes[0] = 1;
    }
    Ok(hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("write to string");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_object_path_and_uri_match_content_address_contract() {
        let descriptor = descriptor_for_bytes(b"profile-bytes", PROFILE_MEDIA_TYPE, None, None);

        assert_eq!(
            descriptor.digest,
            "sha256:f80b93b62cc81c2ae66b7f00f572f1cf1cf7566032501f3e61fe57ee7a0fdd0f"
        );
        assert_eq!(descriptor.byte_length, 13);
        assert_eq!(
            object_path_for_digest(&descriptor.digest),
            "sha256/f8/0b93b62cc81c2ae66b7f00f572f1cf1cf7566032501f3e61fe57ee7a0fdd0f"
        );
        assert_eq!(
            cas_uri_for_digest(&descriptor.digest),
            "cas:sha256/f8/0b93b62cc81c2ae66b7f00f572f1cf1cf7566032501f3e61fe57ee7a0fdd0f"
        );
    }

    #[test]
    fn canonical_manifest_json_matches_shared_contract_ordering() {
        let descriptor = descriptor_for_bytes(b"profile-bytes", PROFILE_MEDIA_TYPE, None, None);
        let manifest = canonical_manifest_json(&[ManifestEntry {
            descriptor,
            logical_path: "profiles/0-cpuprofile".to_owned(),
            role: "profile".to_owned(),
        }]);

        assert_eq!(
            manifest,
            "{\"_tag\":\"ContentManifest\",\"entries\":[{\"descriptor\":{\"_tag\":\"ContentDescriptor\",\"byteLength\":13,\"digest\":\"sha256:f80b93b62cc81c2ae66b7f00f572f1cf1cf7566032501f3e61fe57ee7a0fdd0f\",\"mediaType\":\"application/octet-stream\"},\"logicalPath\":\"profiles/0-cpuprofile\",\"role\":\"profile\"}],\"role\":\"otel-scrape-run\",\"schemaVersion\":1}"
        );
        assert_eq!(
            descriptor_for_bytes(
                manifest.as_bytes(),
                MANIFEST_MEDIA_TYPE,
                Some(CANONICAL_JSON_CODEC),
                Some(1),
            )
            .digest,
            "sha256:d6e6fb6e7842d23684ecd9fdf1f21fd32991be25d475da2601667a690780c2d1"
        );
    }

    #[test]
    fn pin_names_are_relative_roots_not_object_paths() {
        assert!(validate_pin_name("runs/run-1").is_ok());
        assert!(validate_pin_name("../run-1").is_err());
        assert!(validate_pin_name("/tmp/run-1").is_err());
        assert!(validate_pin_name("runs//run-1").is_err());
        assert!(validate_pin_name("runs/./run-1").is_err());
    }
}
