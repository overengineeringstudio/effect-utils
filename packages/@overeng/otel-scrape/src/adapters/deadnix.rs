//! deadnix adapter: structured-in / pretty-out (decision 0017), a thinner mirror
//! of oxlint. Parses deadnix's `--output-format json` report from the child's
//! captured stdout into public-safe records, and renders a human summary in place
//! of the suppressed raw JSON.
//!
//! The one real difference from oxlint is the wire shape: deadnix emits NDJSON —
//! ONE JSON object per file, newline-separated (NOT a top-level array), and a file
//! with no dead code emits ZERO bytes. So the parse stream-deserializes the
//! concatenated objects instead of a single `from_slice`.

use serde::Deserialize;

use super::ToolAdapter;
use crate::{
    hash_path_identity, telemetry_registry, AdapterEvent, AdapterMetric, AdapterOutput,
    AdapterStdoutOwnership, ChildRun, StdoutMode,
};

pub(crate) struct DeadnixAdapter;

impl ToolAdapter for DeadnixAdapter {
    fn name(&self) -> &'static str {
        "deadnix"
    }

    fn stdout_mode(&self, nested: bool) -> StdoutMode {
        if nested {
            // The nested otel-scrape renders; the outer only passes it through.
            StdoutMode::TeeLive
        } else {
            // Leaf: suppress the raw JSON tee and render a summary in its place.
            StdoutMode::CaptureSilent
        }
    }

    fn structured_source(&self, child: &ChildRun) -> Vec<u8> {
        child.stdout.clone().unwrap_or_default()
    }

    fn parse(
        &self,
        source: &[u8],
        ownership: AdapterStdoutOwnership,
    ) -> (Vec<AdapterOutput>, Option<String>) {
        // Only the leaf (this-wrapper) parses and re-renders; a nested invocation
        // passes the inner wrapper's already-rendered summary through untouched
        // (mirrors oxlint's ownership gate).
        if ownership != AdapterStdoutOwnership::ThisWrapper {
            return (Vec::new(), None);
        }
        deadnix_adapter(source)
    }
}

/// One deadnix per-file NDJSON object. We parse ONLY the fields we emit (R27): the
/// `file` supplies the HASHED identity and each result's `line` supplies the event
/// line. `column`/`endColumn` (identifier-length leak) and `message` (carries the
/// dead symbol's source name) are deliberately NOT deserialized — they must never
/// reach a sink.
#[derive(Debug, Deserialize)]
struct DeadnixFile {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    results: Vec<DeadnixResult>,
}

#[derive(Debug, Deserialize)]
struct DeadnixResult {
    /// The 1-based source line of the finding (H5). Public-safe: a plain integer.
    #[serde(default)]
    line: Option<u32>,
}

/// deadnix structured-in / pretty-out (decision 0017): parse the NDJSON
/// `--output-format json` report into public-safe adapter records (constant
/// `"warning"` severity + hashed filename + line + a `deadnix.findings` count),
/// and produce a human summary otel-scrape renders to the terminal in place of the
/// suppressed raw JSON.
///
/// PRECONDITION: the caller must pass `--output-format json` to deadnix (the usage
/// site adopts the format flag, like oxlint's `--format=json`). deadnix has no
/// side-channel, so its JSON on stdout REPLACES the human report; otel-scrape
/// captures stdout and re-renders.
///
/// NDJSON handling (the one difference from oxlint): stream-deserialize the
/// concatenated per-file objects. Empty / whitespace-only input (no dead code)
/// yields zero records with no error (ADP.DEADNIX-R03). On a malformed stream the
/// parse fails and this returns `(outputs so far discarded, None)`, so
/// `present_adapter_stdout` flushes the captured raw bytes instead of swallowing
/// output — the human render is simply unavailable.
fn deadnix_adapter(structured_source: &[u8]) -> (Vec<AdapterOutput>, Option<String>) {
    let mut files: Vec<DeadnixFile> = Vec::new();
    let stream = serde_json::Deserializer::from_slice(structured_source).into_iter::<DeadnixFile>();
    for result in stream {
        match result {
            Ok(file) => files.push(file),
            // A malformed stream: flush raw bytes rather than a partial render.
            Err(_) => return (Vec::new(), None),
        }
    }

    let total_findings: usize = files.iter().map(|file| file.results.len()).sum();

    let mut records = Vec::with_capacity(total_findings + 1);
    records.push(AdapterOutput::Metric(AdapterMetric {
        name: telemetry_registry::metrics::DEADNIX_FINDINGS,
        value: total_findings as u64,
    }));

    for file in &files {
        let filename_hash = file.file.as_deref().map(hash_path_identity);
        for finding in &file.results {
            records.push(AdapterOutput::Event(AdapterEvent {
                // deadnix has no severity field — synthesize the constant
                // `"warning"` for oxlint event-shape parity (DQ-deadnix-2).
                severity: "warning".into(),
                filename_hash: filename_hash.clone(),
                // No machine-readable rule/kind exists (R27, DQ-deadnix-1).
                rule: None,
                line: finding.line,
            }));
        }
    }

    let render = deadnix_render(&files, total_findings);
    (records, Some(render))
}

/// The terminal render for deadnix (decision 0017 clause 4, R30). This is the
/// operator's own machine, not a telemetry sink, so it MAY show file + line. The
/// sink-facing records never carry the raw path (only the hashed identity). The
/// `message` (dead symbol name) is never parsed, so it cannot appear even here.
fn deadnix_render(files: &[DeadnixFile], total_findings: usize) -> String {
    let file_count = files.iter().filter(|file| !file.results.is_empty()).count();
    let mut out = format!("deadnix: {total_findings} finding(s) over {file_count} file(s)\n",);
    for file in files {
        let name = file.file.as_deref().unwrap_or("<unknown>");
        for finding in &file.results {
            out.push_str("  warning  ");
            out.push_str(name);
            if let Some(line) = finding.line {
                out.push(':');
                out.push_str(&line.to_string());
            }
            out.push('\n');
        }
    }
    out
}
