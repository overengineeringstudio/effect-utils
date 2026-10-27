//! Method-scoped presigned transport. Never propagate client errors containing URLs.
use crate::Result;
use std::{
    fs::{self, File},
    io,
    path::Path,
    time::Duration,
};

pub trait Transport {
    fn put(&self, archive: &Path, url: &str) -> Result<()>;
    fn get(&self, url: &str, output: &Path) -> Result<()>;
}
pub struct PresignedHttp {
    agent: ureq::Agent,
}
impl Default for PresignedHttp {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::new_with_config(
                ureq::Agent::config_builder()
                    .https_only(true)
                    .max_redirects(0)
                    .http_status_as_error(false)
                    .timeout_global(Some(Duration::from_secs(300)))
                    .build(),
            ),
        }
    }
}
pub fn read_url(path: &Path) -> Result<String> {
    if fs::metadata(path)?.len() > 65536 {
        return Err("presigned URL file is too large".into());
    }
    let value = fs::read_to_string(path)?;
    let value = value.trim();
    let uri: ureq::http::Uri = value.parse().map_err(|_| "invalid presigned HTTPS URL")?;
    if uri.scheme_str() != Some("https")
        || uri.host().is_none()
        || uri.authority().is_some_and(|a| a.as_str().contains('@'))
        || value.contains('#')
    {
        return Err("invalid presigned HTTPS URL".into());
    }
    Ok(value.to_owned())
}
impl Transport for PresignedHttp {
    fn put(&self, archive: &Path, url: &str) -> Result<()> {
        let file = File::open(archive)?;
        let response = self
            .agent
            .put(url)
            .header("If-None-Match", "*")
            .header("Content-Type", "application/gzip")
            .send(file)
            .map_err(|_| "presigned PUT transport failed (URL redacted)")?;
        if response.status().as_u16() == 412 {
            return Err(
                "object already exists; PUT-only authorization cannot verify its digest".into(),
            );
        }
        if !response.status().is_success() {
            return Err(format!(
                "presigned PUT failed: HTTP {} (URL redacted)",
                response.status().as_u16()
            )
            .into());
        }
        Ok(())
    }
    fn get(&self, url: &str, output: &Path) -> Result<()> {
        let mut response = self
            .agent
            .get(url)
            .call()
            .map_err(|_| "presigned GET transport failed (URL redacted)")?;
        if !response.status().is_success() {
            return Err(format!(
                "presigned GET failed: HTTP {} (URL redacted)",
                response.status().as_u16()
            )
            .into());
        }
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        io::copy(&mut response.body_mut().as_reader(), &mut temporary)
            .map_err(|_| "presigned GET body failed (URL redacted)")?;
        temporary.persist_noclobber(output).map_err(|e| e.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_file_validation_never_reports_the_secret() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("url");
        for invalid in [
            "http://example.invalid/secret-token",
            "https://user:secret-token@example.invalid/object",
            "https://example.invalid/object#secret-token",
            "secret-token",
        ] {
            fs::write(&path, invalid).unwrap();
            let error = read_url(&path).unwrap_err().to_string();
            assert!(!error.contains("secret-token"));
        }
        fs::write(
            &path,
            "https://example.invalid/object?signature=secret-token\n",
        )
        .unwrap();
        assert_eq!(
            read_url(&path).unwrap(),
            "https://example.invalid/object?signature=secret-token"
        );
    }

    #[test]
    fn client_errors_are_redacted_and_partial_downloads_are_not_published() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("archive");
        let client = PresignedHttp::default();
        // HTTPS-only rejects this locally, without making any network request.
        let error = client
            .get("http://example.invalid/secret-token", &output)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-token"));
        assert!(!output.exists());
        fs::write(root.path().join("input"), b"archive").unwrap();
        let error = client
            .put(
                &root.path().join("input"),
                "http://example.invalid/secret-token",
            )
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-token"));
    }
}
