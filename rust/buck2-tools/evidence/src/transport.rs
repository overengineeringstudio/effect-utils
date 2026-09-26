//! Reproducible tar transport for immutable records; never deletes local evidence.
use std::{fs, path::Path, time::Duration};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use crate::store::Manifest;

pub fn bundle(spool: &Path) -> Result<(String, Vec<u8>)> {
    let manifest_bytes = fs::read(spool.join("manifest.json")).context("seal before upload")?;
    let digest = hex::encode(Sha256::digest(&manifest_bytes));
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
    let files: Vec<crate::store::FileEntry> = match manifest["schema"].as_str() {
        Some("buck2-run-record/v1") => serde_json::from_value::<Manifest>(manifest)?.files,
        Some("buck2-attempt-close/v1") => Vec::new(),
        _ => bail!("unknown manifest schema"),
    };
    let mut tar = tar::Builder::new(Vec::new());
    tar.append_path_with_name(spool.join("manifest.json"), "manifest.json")?;
    for file in &files {
        let relative = Path::new(&file.path);
        if !relative.components().all(|c| matches!(c, std::path::Component::Normal(_))) { bail!("invalid file path"); }
        let data = fs::read(spool.join(relative))?;
        if data.len() as u64 != file.bytes || hex::encode(Sha256::digest(&data)) != file.sha256 { bail!("sealed spool changed: {}", file.path); }
        tar.append_path_with_name(spool.join(relative), relative)?;
    }
    Ok((digest, tar.into_inner()?))
}

pub async fn upload(spool: &Path, url: Option<&str>) -> Result<String> {
    let (digest, body) = bundle(spool)?;
    let credential = std::env::var("BUCK2_EVIDENCE_UPLOAD_TOKEN").ok().filter(|s| !s.is_empty());
    let is_close = serde_json::from_slice::<serde_json::Value>(&fs::read(spool.join("manifest.json"))?)?["schema"] == "buck2-attempt-close/v1";
    let Some(url) = url else { return Ok(format!("spool-only sha256:{digest}")); };
    let (client, base) = if let Some(socket) = url.strip_prefix("unix://") {
        (reqwest::Client::builder().timeout(Duration::from_secs(40)).unix_socket(socket).build()?, "http://localhost".to_owned())
    } else {
        if credential.is_none() && !(url.starts_with("https://") && url.split('/').nth(2).is_some_and(|host| host.ends_with(".ts.net"))) {
            return Ok(format!("spool-only sha256:{digest} (no authenticated transport)"));
        }
        (reqwest::Client::builder().timeout(Duration::from_secs(40)).build()?, url.trim_end_matches('/').to_owned())
    };
    let endpoint = format!("{base}/v1/{}/sha256/{digest}", if is_close { "attempt-close" } else { "records" });
    for attempt in 0..5u32 {
        let mut request = client.put(&endpoint).header("if-none-match", "*").body(body.clone());
        if let Some(token) = &credential { request = request.bearer_auth(token); }
        let response = request.send().await;
        match response {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::CONFLICT => {
                // A remote acknowledgement is not permission to discard the spool.
                let (verified, _) = bundle(spool)?;
                if verified != digest { bail!("local seal changed during upload"); }
                return Ok(format!("uploaded sha256:{digest}"));
            }
            Ok(r) if r.status().is_client_error() => bail!("upload rejected: {}", r.status()),
            Err(e) if attempt == 4 => return Err(e.into()),
            Ok(r) if attempt == 4 => bail!("upload failed: {}", r.status()),
            _ => tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await,
        }
    }
    unreachable!()
}
