//! Seals a spool without altering its native event logs or span lines.
use std::{fs, io::Read, path::{Component, Path}};
use anyhow::{bail, Context, Result};
use serde_json::json;
use sha2::{Digest, Sha256};
use crate::store::{FileEntry, Manifest, RunBlock};

fn digest_file(path: &Path) -> Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        hash.update(&buf[..n]);
        bytes += n as u64;
    }
    Ok((bytes, hex::encode(hash.finalize())))
}

fn gather(root: &Path, path: &Path, files: &mut Vec<FileEntry>) -> Result<()> {
    for item in fs::read_dir(path)? {
        let item = item?;
        let p = item.path();
        let ty = item.file_type()?;
        if ty.is_symlink() { bail!("symlinks are not sealed: {}", p.display()); }
        if ty.is_dir() { gather(root, &p, files)?; }
        else if ty.is_file() {
            let relative = p.strip_prefix(root)?.to_str().context("non-UTF-8 spool path")?;
            if relative == "manifest.json" { continue; }
            if !relative.starts_with("spans/") && !relative.starts_with("buck2/") { bail!("unexpected spool file: {relative}"); }
            if Path::new(relative).components().any(|c| !matches!(c, Component::Normal(_))) { bail!("invalid spool path"); }
            let (bytes, sha256) = digest_file(&p)?;
            files.push(FileEntry { path: relative.into(), bytes, sha256 });
        }
    }
    Ok(())
}

fn env(name: &str) -> Option<String> { std::env::var(name).ok().filter(|s| !s.is_empty()) }
fn revision(name: &str) -> Result<Option<String>> {
    match env(name) {
        Some(value) if value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(Some(value.to_ascii_lowercase())),
        Some(_) => bail!("{name} must be a 40-hex revision"),
        None => Ok(None),
    }
}

/// Return the manifest digest; writing the manifest is the seal's last operation.
pub fn seal(spool: &Path, pipeline_run_id: &str, task_key: &str) -> Result<String> {
    if pipeline_run_id.is_empty() || task_key.is_empty() { bail!("run and task identities must be nonempty"); }
    fs::create_dir_all(spool)?;
    let mut files = Vec::new();
    for subdir in ["spans", "buck2"] { if spool.join(subdir).exists() { gather(spool, &spool.join(subdir), &mut files)?; } }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let target = spool.join("manifest.json");
    if target.exists() {
        let old = fs::read(&target)?;
        let sealed: Manifest = serde_json::from_slice(&old)?;
        if sealed.run.pipeline_run_id != pipeline_run_id || sealed.run.job_key != task_key
            || sealed.files.len() != files.len()
            || !sealed.files.iter().zip(&files).all(|(a, b)| a.path == b.path && a.bytes == b.bytes && a.sha256 == b.sha256) {
            bail!("sealed spool changed; refusing to overwrite manifest");
        }
        return Ok(hex::encode(Sha256::digest(&old)));
    }
    let repository = env("PIPELINE_REPOSITORY").unwrap_or_else(|| "local/unknown".into());
    let (run_id, attempt) = if pipeline_run_id.starts_with("ci/") {
        let fields: Vec<_> = pipeline_run_id.split('/').collect();
        let id = fields.get(fields.len().saturating_sub(2)).context("invalid CI run id")?;
        let attempt = fields.last().context("invalid CI attempt")?.parse::<u32>()?;
        ((*id).to_owned(), attempt)
    } else { (pipeline_run_id.to_owned(), 1) };
    let run = RunBlock {
        repository,
        pipeline_run_id: pipeline_run_id.into(), run_id, attempt,
        job_key: task_key.into(), event: env("PIPELINE_EVENT").unwrap_or_else(|| "local".into()),
        worker: json!({"os": std::env::consts::OS, "arch": std::env::consts::ARCH}),
        fork: env("PIPELINE_FORK").as_deref() == Some("true"),
        trusted: env("PIPELINE_TRUSTED").as_deref() != Some("false"),
    };
    let head = revision("VCS_REF_HEAD_REVISION")?.or_else(|| {
        std::process::Command::new("git").args(["rev-parse", "HEAD"]).output().ok().and_then(|v| {
            let sha = String::from_utf8(v.stdout).ok()?.trim().to_owned();
            (v.status.success() && sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sha)
        })
    });
    let manifest = Manifest {
        schema: "buck2-run-record/v1".into(),
        producer: json!({"converter": env!("CARGO_PKG_VERSION"), "sealedAt": now_rfc3339()?}),
        run, files,
        vcs_change_id: env("VCS_CHANGE_ID"), vcs_head: head,
        vcs_base: revision("VCS_REF_BASE_REVISION")?,
        vcs_merge: revision("BUCK2_VCS_MERGE_REVISION")?,
    };
    let bytes = serde_json::to_vec(&manifest)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    let temp = spool.join("manifest.json.tmp");
    fs::write(&temp, &bytes)?;
    fs::rename(temp, target)?;
    Ok(digest)
}

fn now_rfc3339() -> Result<String> {
    let output = std::process::Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()?;
    if !output.status.success() { bail!("UTC timestamp unavailable"); }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
