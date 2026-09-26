//! Immutable Buck evidence records, durable ingest, and indexed trace access.
pub mod http;
pub mod close;
pub mod index;
pub mod pipeline;
pub mod retention;
pub mod resolver;
pub mod seal;
pub mod store;
pub mod transport;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};

pub const NS: &str = "buck2-evidence/v1";

#[derive(Clone, Debug)]
pub struct Config {
    /// State root (the dotfiles unit's StateDirectory / ZFS dataset in production).
    pub state: PathBuf,
    /// OTLP/HTTP base (loopback Alloy gateway in production).
    pub otlp: String,
    /// Tempo HTTP API base for by-id readback.
    pub tempo: String,
    /// Upper bound for one readback wait before the step reports a transient failure.
    pub readback_timeout: Duration,
    /// Grafana base for `/t/<id>` redirects.
    pub grafana: String,
}

impl Config {
    pub fn incoming(&self) -> PathBuf {
        self.state.join("incoming")
    }
    pub fn store(&self) -> PathBuf {
        self.state.join("store/sha256")
    }
    pub fn archive(&self) -> PathBuf {
        self.state.join("archive")
    }
    pub fn work(&self) -> PathBuf {
        self.state.join("work")
    }
    pub fn index_path(&self) -> PathBuf {
        self.state.join("index.sqlite")
    }
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for d in [self.incoming(), self.store(), self.archive(), self.work()] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }
}

/// Step outcome classification: the driver (queue or Restate) decides what to do with it.
#[derive(Debug)]
pub enum StepError {
    /// Retry later (Tempo/Alloy down, readback not complete yet, IO hiccup).
    Transient(String),
    /// Never succeeds on retry (corrupt record, adapter rejects the log): dead-letter.
    Permanent(String),
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepError::Transient(m) => write!(f, "transient: {m}"),
            StepError::Permanent(m) => write!(f, "permanent: {m}"),
        }
    }
}
impl std::error::Error for StepError {}

pub type StepResult<T> = Result<T, StepError>;

pub fn transient(e: impl std::fmt::Display) -> StepError {
    StepError::Transient(e.to_string())
}
pub fn permanent(e: impl std::fmt::Display) -> StepError {
    StepError::Permanent(e.to_string())
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `sha256(input)` truncated to `len` hex chars (trace id 32, span id 16).
pub fn hash_hex(input: &str, len: usize) -> String {
    let mut h = sha256_hex(input.as_bytes());
    h.truncate(len);
    h
}

/// Framed pre-manifest identity shared with the run entrypoint.
pub mod ids {
    use sha2::{Digest, Sha256};

    fn framed(domain: &str, inputs: &[&str], len: usize) -> String {
        let mut bytes = Vec::with_capacity(domain.len() + inputs.iter().map(|s| s.len() + 4).sum::<usize>() + 5);
        bytes.extend_from_slice(domain.as_bytes());
        bytes.push(0);
        for input in inputs {
            bytes.extend_from_slice(&(input.len() as u32).to_be_bytes());
            bytes.extend_from_slice(input.as_bytes());
        }
        for counter in 0u32.. {
            let h = Sha256::digest(&bytes);
            let truncated = &h[..len];
            if truncated.iter().any(|b| *b != 0) { return hex::encode(truncated); }
            bytes.extend_from_slice(&(counter + 1).to_be_bytes());
        }
        unreachable!()
    }
    pub fn run_trace(run: &str) -> String {
        framed("buck2.pipeline-run.trace/v1", &[run], 16)
    }
    pub fn run_root_span(run: &str) -> String {
        framed("buck2.pipeline-run.root/v1", &[run], 8)
    }
    pub fn job_span(run: &str, job: &str) -> String {
        framed("buck2.pipeline-run.job/v1", &[run, job], 8)
    }
    pub fn view_trace(uuid: &str, view: &str) -> String {
        let digest = Sha256::digest(format!("{uuid}:{view}").as_bytes());
        hex::encode(&digest[..16])
    }
}

#[cfg(test)]
mod identity_tests {
    use super::ids;
    #[test]
    fn matches_run_entrypoint_vectors() {
        let run = "local/38d198bc-4ba9-42b1-b11c-60f1a2a00db1";
        assert_eq!(ids::run_trace(run), "4c5cf5acb050a9cd662e1fc7714f6eb3");
        assert_eq!(ids::run_root_span(run), "ddafe71fe577aaee");
        assert_eq!(ids::job_span(run, "worker/local"), "94858ceb03926a01");
        let run = "ci/forge/repo%2Fmodule/421/2";
        assert_eq!(ids::run_trace(run), "7a371c25e1cdd9310f41bf4e68258873");
        assert_eq!(ids::run_root_span(run), "8575a743f3e704ce");
        assert_eq!(ids::job_span(run, "build[os=linux]"), "375a82ccc85b7720");
    }
}
