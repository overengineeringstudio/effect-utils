//! oxlint adapter: structured-in / pretty-out (decision 0017). Parses oxlint's
//! `--format=json` report from the child's captured stdout into public-safe
//! records, and renders a human summary in place of the suppressed raw JSON.

use serde::Deserialize;

use super::ToolAdapter;
use crate::{
    hash_path_identity, telemetry_registry, AdapterEvent, AdapterMetric, AdapterOutput,
    AdapterStdoutOwnership, ChildRun, StdoutMode,
};

pub(crate) struct OxlintAdapter;

impl ToolAdapter for OxlintAdapter {
    fn name(&self) -> &'static str {
        "oxlint"
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
        // (the previous `(ThisWrapper, OXLINT_ADAPTER)` dispatch arm).
        if ownership != AdapterStdoutOwnership::ThisWrapper {
            return (Vec::new(), None);
        }
        oxlint_adapter(source)
    }
}

#[derive(Debug, Deserialize)]
struct OxlintJson {
    #[serde(default)]
    diagnostics: Vec<OxlintDiagnostic>,
}

#[derive(Debug, Deserialize)]
struct OxlintDiagnostic {
    message: String,
    severity: String,
    filename: Option<String>,
    /// The oxlint rule code (e.g. `eslint(no-unused-vars)`). Public-safe (H5):
    /// emitted verbatim as the sink-facing `rule`. Parsed defensively and
    /// omitted when absent.
    #[serde(default)]
    code: Option<String>,
    /// Diagnostic source labels (oxlint miette JSON): each carries a `span`
    /// whose `line` is the public-safe 1-based location (H5). Parsed defensively;
    /// the first label with a line supplies the event `line`.
    #[serde(default)]
    labels: Vec<OxlintLabel>,
}

#[derive(Debug, Deserialize)]
struct OxlintLabel {
    #[serde(default)]
    span: Option<OxlintSpan>,
}

#[derive(Debug, Deserialize)]
struct OxlintSpan {
    #[serde(default)]
    line: Option<u32>,
}

/// oxlint structured-in / pretty-out (decision 0017): parse the `--format=json`
/// report into public-safe adapter records (severity + hashed filename + count),
/// and produce a human summary otel-scrape renders to the terminal in place of the
/// suppressed raw JSON.
///
/// PRECONDITION: the caller must pass `--format=json` to oxlint (0017 clause 2 —
/// the usage site adopts the format flag). oxlint has no side-channel, so its
/// human output on stdout IS its default format; otel-scrape captures stdout and
/// re-renders. On non-JSON stdout the parse fails and this returns `(outputs,
/// None)`, so `present_adapter_stdout` flushes the captured raw bytes instead of
/// swallowing output — the human render is simply unavailable.
fn oxlint_adapter(structured_source: &[u8]) -> (Vec<AdapterOutput>, Option<String>) {
    let Ok(report) = serde_json::from_slice::<OxlintJson>(structured_source) else {
        return (Vec::new(), None);
    };

    let mut records = Vec::with_capacity(report.diagnostics.len() + 1);
    records.push(AdapterOutput::Metric(AdapterMetric {
        name: telemetry_registry::metrics::OXLINT_DIAGNOSTICS,
        value: report.diagnostics.len() as u64,
    }));

    for diagnostic in &report.diagnostics {
        records.push(AdapterOutput::Event(AdapterEvent {
            severity: diagnostic.severity.clone(),
            filename_hash: diagnostic.filename.as_deref().map(hash_path_identity),
            // rule = the linter code verbatim; line = the first labelled source
            // line (H5). Both public-safe (a rule name + an integer); the path
            // stays hashed above.
            rule: diagnostic.code.clone(),
            line: diagnostic
                .labels
                .iter()
                .find_map(|label| label.span.as_ref().and_then(|span| span.line)),
        }));
    }

    let render = oxlint_render(&report.diagnostics);
    (records, Some(render))
}

/// The terminal render for oxlint (decision 0017 clause 3, R30). This is the
/// operator's own machine, not a telemetry sink, so it MAY show full messages and
/// paths (clause 4). The sink-facing records never carry them.
fn oxlint_render(diagnostics: &[OxlintDiagnostic]) -> String {
    let file_count = diagnostics
        .iter()
        .filter_map(|diagnostic| diagnostic.filename.as_deref())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let mut out = format!(
        "oxlint: {} diagnostic(s) over {} file(s)\n",
        diagnostics.len(),
        file_count,
    );
    for diagnostic in diagnostics {
        let file = diagnostic.filename.as_deref().unwrap_or("<unknown>");
        out.push_str("  ");
        out.push_str(&diagnostic.severity);
        out.push_str("  ");
        out.push_str(file);
        if let Some(code) = diagnostic.code.as_deref() {
            out.push_str("  ");
            out.push_str(code);
        }
        out.push_str("  ");
        out.push_str(&diagnostic.message);
        out.push('\n');
    }
    out
}
