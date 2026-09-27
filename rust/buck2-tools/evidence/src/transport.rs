//! Reproducible tar transport for immutable records; never deletes local evidence.
use crate::store::Manifest;
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{fs, io::ErrorKind, path::Path, time::Duration};

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
        if !relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            bail!("invalid file path");
        }
        let data = fs::read(spool.join(relative))?;
        if data.len() as u64 != file.bytes || hex::encode(Sha256::digest(&data)) != file.sha256 {
            bail!("sealed spool changed: {}", file.path);
        }
        tar.append_path_with_name(spool.join(relative), relative)?;
    }
    Ok((digest, tar.into_inner()?))
}

/// A marker exists before the first byte is sent. Its presence means offline
/// ingest cannot safely run: the service may have accepted a lost response.
pub async fn upload(spool: &Path, url: Option<&str>) -> Result<String> {
    let (digest, body) = bundle(spool)?;
    let is_close =
        serde_json::from_slice::<serde_json::Value>(&fs::read(spool.join("manifest.json"))?)?
            ["schema"]
            == "buck2-attempt-close/v1";
    let Some(url) = url else {
        return Ok(format!("spool-only sha256:{digest}"));
    };
    let marker = spool.join("upload-pending");
    let endpoint_hash = crate::sha256_hex(url.as_bytes());
    let was_pending = marker.exists();
    if was_pending {
        if fs::read_to_string(&marker)? != endpoint_hash {
            bail!("pending evidence belongs to a different upload endpoint");
        }
    } else {
        let tmp = spool.join("upload-pending.tmp");
        fs::write(&tmp, &endpoint_hash)?;
        fs::rename(tmp, &marker)?;
    }
    let credential = std::env::var("BUCK2_EVIDENCE_UPLOAD_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    let (client, base) = if let Some(socket) = url.strip_prefix("unix://") {
        (
            reqwest::Client::builder()
                .timeout(Duration::from_secs(40))
                .unix_socket(socket)
                .build()?,
            "http://localhost".to_owned(),
        )
    } else {
        if credential.is_none()
            && !(url.starts_with("https://")
                && url
                    .split('/')
                    .nth(2)
                    .is_some_and(|host| host.ends_with(".ts.net")))
        {
            bail!("upload URL is configured but no authenticated transport is available");
        }
        (
            reqwest::Client::builder()
                .timeout(Duration::from_secs(40))
                .build()?,
            url.trim_end_matches('/').to_owned(),
        )
    };
    let endpoint = format!(
        "{base}/v1/{}/sha256/{digest}",
        if is_close { "attempt-close" } else { "records" }
    );
    let mut ambiguous = was_pending;
    for attempt in 0..5u32 {
        let mut request = client
            .put(&endpoint)
            .header("if-none-match", "*")
            .body(body.clone());
        if let Some(token) = &credential {
            request = request.bearer_auth(token);
        }
        let response = request.send().await;
        match response {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::CONFLICT => {
                let (verified, _) = bundle(spool)?;
                if verified != digest {
                    bail!("local seal changed during upload");
                }
                // A concurrent replay may confirm the request while its original
                // caller is still awaiting a response. Preserve that proof before
                // clearing the pending marker.
                fs::write(spool.join("upload-confirmed"), &endpoint_hash)?;
                fs::remove_file(&marker)?;
                return Ok(format!("uploaded sha256:{digest}"));
            }
            Ok(r) if r.status().is_client_error() => {
                if !ambiguous {
                    fs::remove_file(&marker)?;
                }
                bail!("upload rejected: {}", r.status());
            }
            Err(e) => {
                if !definitely_not_sent(&e) {
                    ambiguous = true;
                }
                if attempt == 4 {
                    if !ambiguous {
                        fs::remove_file(&marker)?;
                    }
                    return Err(e.into());
                }
            }
            Ok(r) => {
                ambiguous = true;
                if attempt == 4 {
                    bail!("upload failed: {}", r.status());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
    }
    unreachable!()
}

fn definitely_not_sent(error: &reqwest::Error) -> bool {
    if !error.is_connect() {
        return false;
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return matches!(
                io.kind(),
                ErrorKind::ConnectionRefused | ErrorKind::NotFound
            );
        }
        source = cause.source();
    }
    false
}

pub async fn upload_pending(root: &Path, url: &str) -> Result<usize> {
    let mut runs = match fs::read_dir(root) {
        Ok(entries) => entries.collect::<std::io::Result<Vec<_>>>()?,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    runs.sort_by_key(|entry| entry.file_name());
    let mut uploaded = 0;
    for run in runs {
        if !run.file_type()?.is_dir() {
            continue;
        }
        let job = run.path();
        let close = job.join("attempt-close");
        let close_pending = close.join("upload-pending").exists();
        let close_confirmed = close.join("upload-confirmed").exists();
        if close_confirmed
            && fs::read_to_string(close.join("upload-confirmed"))?
                != crate::sha256_hex(url.as_bytes())
        {
            bail!("confirmed close belongs to a different upload endpoint");
        }
        if close_pending {
            upload(&close, Some(url)).await?;
            uploaded += 1;
        }
        // A lost close acknowledgement occurs before the job PUT is attempted.
        // A confirmed close with an unconfirmed job is also service-owned,
        // even when that job's last attempt was definitively refused.
        if !job.join("upload-confirmed").exists()
            && (job.join("upload-pending").exists() || close_pending || close_confirmed)
            && job.join("manifest.json").exists()
        {
            upload(&job, Some(url)).await?;
            uploaded += 1;
        }
    }
    Ok(uploaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const RECORD: &[u8] = br#"{"schema":"buck2-run-record/v1","producer":{},"run":{"repository":"owner/repo","pipelineRunId":"local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1","runId":"local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1","attempt":1,"jobKey":"worker/local"},"files":[]}"#;

    #[tokio::test]
    async fn accepted_request_with_lost_response_replays_without_offline_ingest() {
        let root = std::env::temp_dir().join(format!(
            "buck2-upload-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        let spool = root.join("run");
        fs::create_dir_all(&spool).unwrap();
        fs::write(spool.join("manifest.json"), RECORD).unwrap();
        let socket = root.join("service.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let respond = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn({
            let respond = Arc::clone(&respond);
            let requests = Arc::clone(&requests);
            async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut received = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        received.extend_from_slice(&buffer[..n]);
                        if let Some(headers_end) =
                            received.windows(4).position(|v| v == b"\r\n\r\n")
                        {
                            let headers = String::from_utf8_lossy(&received[..headers_end])
                                .to_ascii_lowercase();
                            let len = headers
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length: "))
                                .and_then(|n| n.parse::<usize>().ok())
                                .unwrap();
                            if received.len() >= headers_end + 4 + len {
                                requests.fetch_add(1, Ordering::SeqCst);
                                if respond.load(Ordering::SeqCst) {
                                    stream
                                        .write_all(
                                            b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n",
                                        )
                                        .await
                                        .unwrap();
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });
        let url = format!("unix://{}", socket.display());
        assert!(upload(&spool, Some(&url)).await.is_err());
        assert_eq!(
            requests.load(Ordering::SeqCst),
            5,
            "all failed replies followed accepted bodies"
        );
        assert!(
            spool.join("upload-pending").exists(),
            "offline ingest must be withheld"
        );
        respond.store(true, Ordering::SeqCst);
        assert_eq!(upload_pending(&root, &url).await.unwrap(), 1);
        assert!(
            !spool.join("upload-pending").exists(),
            "409 confirms the replay"
        );
        let next = root.join("next");
        let next_close = next.join("attempt-close");
        fs::create_dir_all(&next_close).unwrap();
        fs::write(next.join("manifest.json"), RECORD).unwrap();
        fs::write(
            next_close.join("manifest.json"),
            br#"{"schema":"buck2-attempt-close/v1"}"#,
        )
        .unwrap();
        fs::write(
            next_close.join("upload-pending"),
            crate::sha256_hex(url.as_bytes()),
        )
        .unwrap();
        assert_eq!(
            upload_pending(&root, &url).await.unwrap(),
            2,
            "a lost close reply must replay both close and never-attempted job"
        );
        assert!(!next_close.join("upload-pending").exists());
        assert_eq!(requests.load(Ordering::SeqCst), 8);
        server.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn definite_refusal_allows_offline_only_without_prior_ambiguity() {
        let root = std::env::temp_dir().join(format!(
            "buck2-refused-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        let spool = root.join("run");
        fs::create_dir_all(&spool).unwrap();
        fs::write(spool.join("manifest.json"), RECORD).unwrap();
        let url = format!("unix://{}", root.join("missing.sock").display());
        assert!(upload(&spool, Some(&url)).await.is_err());
        assert!(
            !spool.join("upload-pending").exists(),
            "a never-connected service cannot already own this record"
        );
        fs::write(
            spool.join("upload-pending"),
            crate::sha256_hex(url.as_bytes()),
        )
        .unwrap();
        assert!(upload(&spool, Some(&url)).await.is_err());
        assert!(
            spool.join("upload-pending").exists(),
            "prior ambiguous acceptance stays pending even after later refusal"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
