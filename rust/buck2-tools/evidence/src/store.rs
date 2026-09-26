//! Content-addressed record store: `PUT /v1/records/sha256/<digest>` lands here.
//!
//! incoming/<digest>.<nonce>/  (unpack + verify)  ->  store/sha256/<digest>/  (atomic rename)
//! The rename is the durability point: after it, the sweep can always find the record even if
//! the enqueue that follows never happened.
use std::{collections::HashSet, io::Read};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{now_ms, permanent, sha256_hex, transient, Config, StepResult};

pub const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: String,
    pub producer: serde_json::Value,
    pub run: RunBlock,
    #[serde(rename = "vcs.change.id", skip_serializing_if = "Option::is_none", default)]
    pub vcs_change_id: Option<String>,
    #[serde(rename = "vcs.ref.head.revision", skip_serializing_if = "Option::is_none", default)]
    pub vcs_head: Option<String>,
    #[serde(rename = "vcs.ref.base.revision", skip_serializing_if = "Option::is_none", default)]
    pub vcs_base: Option<String>,
    #[serde(rename = "buck2.vcs.merge.revision", skip_serializing_if = "Option::is_none", default)]
    pub vcs_merge: Option<String>,
    pub files: Vec<FileEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBlock {
    pub repository: String,
    #[serde(default)]
    pub pipeline_run_id: String,
    pub run_id: String,
    pub attempt: u32,
    #[serde(alias = "job")]
    pub job_key: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub worker: serde_json::Value,
    #[serde(default)]
    pub fork: bool,
    #[serde(default)]
    pub trusted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub enum UploadOutcome {
    /// First time this digest reached the store.
    Stored(Manifest),
    /// Same bytes already stored (or archived): a no-op by construction.
    AlreadyStored,
}

#[derive(Debug)]
pub enum UploadError {
    /// Digest/format mismatch: the client must not retry the same bytes.
    Rejected(String),
    Io(String),
}

pub fn is_digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn record_dir(cfg: &Config, digest: &str) -> PathBuf {
    cfg.store().join(digest)
}

pub fn read_manifest(dir: &Path) -> StepResult<Manifest> {
    let bytes = std::fs::read(dir.join("manifest.json")).map_err(transient)?;
    serde_json::from_slice(&bytes).map_err(permanent)
}

/// Unpacks a tar body, verifies manifest digest + every file digest, then renames into the store.
/// Blocking: call from `spawn_blocking`.
pub fn accept(cfg: &Config, digest: &str, body: &[u8]) -> Result<UploadOutcome, UploadError> {
    if !is_digest(digest) {
        return Err(UploadError::Rejected("digest must be 64 lowercase hex".into()));
    }
    if body.len() > MAX_BODY {
        return Err(UploadError::Rejected("record exceeds 64 MiB".into()));
    }
    let dest = record_dir(cfg, digest);
    if dest.exists() {
        return Ok(UploadOutcome::AlreadyStored);
    }
    // Unique per request: concurrent identical PUTs must never share a staging dir.
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stage = cfg.incoming().join(format!("{digest}.{}.{}.{n}", std::process::id(), now_ms()));
    let io = |e: std::io::Error| UploadError::Io(e.to_string());
    std::fs::create_dir_all(&stage).map_err(io)?;
    let result = (|| {
        let mut archive = tar::Archive::new(body);
        let mut seen = HashSet::new();
        let mut unpacked = 0u64;
        for entry in archive.entries().map_err(|e| UploadError::Rejected(e.to_string()))? {
            let mut entry = entry.map_err(|e| UploadError::Rejected(e.to_string()))?;
            if !entry.header().entry_type().is_file() { return Err(UploadError::Rejected("only regular files are permitted".into())); }
            unpacked += entry.header().size().map_err(|e| UploadError::Rejected(e.to_string()))?;
            if unpacked > MAX_BODY as u64 { return Err(UploadError::Rejected("expanded record exceeds 64 MiB".into())); }
            let path = entry.path().map_err(|e| UploadError::Rejected(e.to_string()))?;
            let name = path.to_str().ok_or_else(|| UploadError::Rejected("non-UTF-8 archive path".into()))?.to_owned();
            if !path.components().all(|c| matches!(c, Component::Normal(_)))
                || !(name == "manifest.json" || name.starts_with("spans/") || name.starts_with("buck2/"))
                || !seen.insert(name) {
                return Err(UploadError::Rejected("invalid or repeated archive path".into()));
            }
            if !entry.unpack_in(&stage).map_err(|e| UploadError::Rejected(e.to_string()))? {
                return Err(UploadError::Rejected("path escapes record".into()));
            }
        }
        let manifest_bytes = std::fs::read(stage.join("manifest.json"))
            .map_err(|_| UploadError::Rejected("manifest.json missing".into()))?;
        if sha256_hex(&manifest_bytes) != digest {
            return Err(UploadError::Rejected("manifest digest mismatch".into()));
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| UploadError::Rejected(format!("manifest: {e}")))?;
        if manifest.schema != "buck2-run-record/v1" {
            return Err(UploadError::Rejected("unknown manifest schema".into()));
        }
        if seen.len() != manifest.files.len() + 1 {
            return Err(UploadError::Rejected("unlisted archive file".into()));
        }
        for f in &manifest.files {
            if !seen.contains(&f.path) || !Path::new(&f.path).components().all(|c| matches!(c, Component::Normal(_)))
                || !(f.path.starts_with("spans/") || f.path.starts_with("buck2/")) {
                return Err(UploadError::Rejected("invalid manifest path".into()));
            }
            let mut bytes = Vec::new();
            std::fs::File::open(stage.join(&f.path))
                .and_then(|mut h| h.read_to_end(&mut bytes))
                .map_err(|_| UploadError::Rejected(format!("missing {}", f.path)))?;
            if bytes.len() as u64 != f.bytes || sha256_hex(&bytes) != f.sha256 {
                return Err(UploadError::Rejected(format!("file digest mismatch {}", f.path)));
            }
        }
        Ok(manifest)
    })();
    match result {
        Ok(manifest) => match std::fs::rename(&stage, &dest) {
            Ok(()) => Ok(UploadOutcome::Stored(manifest)),
            // Lost a race with a concurrent identical upload: same bytes, same outcome.
            Err(_) if dest.exists() => {
                let _ = std::fs::remove_dir_all(&stage);
                Ok(UploadOutcome::AlreadyStored)
            }
            Err(e) => Err(io(e)),
        },
        Err(e) => {
            let _ = std::fs::remove_dir_all(&stage);
            Err(e)
        }
    }
}

/// Encode each untrusted identity as one safe path segment; repository keeps
/// exactly its owner/name hierarchy without allowing traversal.
fn segment(value: &str) -> String {
    value.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

pub fn archive_path(cfg: &Config, m: &Manifest, at_ms: i64) -> PathBuf {
    let days = at_ms / 86_400_000;
    let (y, mo, d) = civil_from_days(days);
    let mut path = cfg.archive();
    for part in m.run.repository.split('/') { path.push(segment(part)); }
    path.join(format!("{y:04}/{mo:02}/{d:02}"))
        .join(format!("run-{}", segment(&m.run.run_id)))
        .join(format!("attempt-{}", m.run.attempt))
        .join(format!("job-{}", segment(&m.run.job_key)))
}

/// Moves the stored record into the archive; idempotent (already archived = Ok).
pub fn archive(cfg: &Config, digest: &str, m: &Manifest, at_ms: i64) -> StepResult<PathBuf> {
    let src = record_dir(cfg, digest);
    let dst = archive_path(cfg, m, at_ms);
    if !src.exists() && dst.join("manifest.json").exists() {
        return Ok(dst);
    }
    std::fs::create_dir_all(dst.parent().unwrap()).map_err(transient)?;
    if dst.exists() {
        // A re-upload of the same job key with different bytes: keep both, digest-suffixed.
        let alt = dst.with_file_name(format!("job-{}.{}", segment(&m.run.job_key), &digest[..12]));
        std::fs::rename(&src, &alt).map_err(transient)?;
        return Ok(alt);
    }
    std::fs::rename(&src, &dst).map_err(transient)?;
    Ok(dst)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
