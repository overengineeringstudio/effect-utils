//! vitest adapter: side-channel structured-in (decision 0017). otel-scrape injects
//! a JSON reporter writing to a known file while vitest's human output stays on
//! stdout untouched, then parses public-safe count metrics from that file.

use std::io;
use std::path::PathBuf;

use serde::Deserialize;

use super::{AdapterPrep, ToolAdapter};
use crate::{
    telemetry_registry, AdapterMetric, AdapterOutput, AdapterStdoutOwnership, ChildRun, RunConfig,
    StdoutMode,
};

pub(crate) struct VitestAdapter;

impl ToolAdapter for VitestAdapter {
    fn name(&self) -> &'static str {
        "vitest"
    }

    fn stdout_mode(&self, _nested: bool) -> StdoutMode {
        // vitest is a side-channel adapter: its JSON goes to a file otel-scrape
        // injects; its human output stays on stdout untouched (decision 0017).
        StdoutMode::Inherit
    }

    fn ownership(&self, _nested: bool) -> AdapterStdoutOwnership {
        // The adapter consumes a side-channel and leaves the child's stdout to
        // the child itself — never a wrapper (decision 0017).
        AdapterStdoutOwnership::Inherited
    }

    fn structured_source(&self, child: &ChildRun) -> Vec<u8> {
        child
            .sidechannel_file
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default()
    }

    fn parse(
        &self,
        source: &[u8],
        ownership: AdapterStdoutOwnership,
    ) -> (Vec<AdapterOutput>, Option<String>) {
        // vitest owns its records under the side-channel (inherited) ownership,
        // reproducing the previous `(Inherited, VITEST_ADAPTER)` dispatch arm.
        if ownership != AdapterStdoutOwnership::Inherited {
            return (Vec::new(), None);
        }
        match vitest_outputs(source) {
            Ok(outputs) => (outputs, None),
            // Degrade non-silently (decision 0017 clause 2): warn once to stderr and
            // omit the vitest metrics rather than emitting a misleading 0/0. The
            // wrapped command's own output and exit code are unaffected.
            Err(reason) => {
                eprintln!(
                    "otel-scrape: warning: vitest side-channel unavailable ({reason}); skipping vitest metrics"
                );
                (Vec::new(), None)
            }
        }
    }

    /// Plan the vitest side-channel for this invocation (decision 0017).
    /// otel-scrape ensures a JSON reporter + a known output path so it can read
    /// structured counts, WITHOUT clobbering user-supplied flags:
    ///   - a pre-existing `--outputFile.json` is read in place and never deleted;
    ///   - a pre-existing human `--reporter` is preserved (only `--reporter=json`
    ///     is added alongside — vitest supports multiple reporters);
    ///   - only when the user passed no `--reporter` at all does otel-scrape inject
    ///     `--reporter=default` (verified: `--reporter=json` alone blanks the
    ///     terminal).
    fn prepare(&self, config: &RunConfig) -> io::Result<AdapterPrep> {
        let user = scan_vitest_user_flags(&config.argv);

        let mut inject_args = Vec::new();
        if !user.has_any_reporter {
            // No user reporter: keep vitest's human output AND add the JSON side-channel.
            inject_args.push("--reporter=default".to_owned());
            inject_args.push("--reporter=json".to_owned());
        } else if !user.has_json_reporter {
            // Preserve the user's human reporter(s); add only the JSON side-channel.
            inject_args.push("--reporter=json".to_owned());
        }
        // else: the user already asked for a JSON reporter — inject no reporter flag.

        match user.output_file_json {
            // A user-supplied `--outputFile.json` is read in place, never deleted.
            Some(read_path) => Ok(AdapterPrep {
                inject_args,
                sidechannel_file: Some(read_path),
                sidechannel_owned: false,
                ..AdapterPrep::default()
            }),
            None => {
                let suffix = crate::random_hex(8)?;
                let read_path =
                    std::env::temp_dir().join(format!("otel-scrape-vitest-{suffix}.json"));
                inject_args.push(format!("--outputFile.json={}", read_path.display()));
                Ok(AdapterPrep {
                    inject_args,
                    sidechannel_file: Some(read_path),
                    sidechannel_owned: true,
                    ..AdapterPrep::default()
                })
            }
        }
    }

    /// Remove the vitest side-channel file after its structured source is consumed
    /// (decision 0017). Only removes a file otel-scrape created — a user-supplied
    /// `--outputFile.json` is left untouched (data-loss guard, clause 2).
    /// Best-effort: a failure here never affects the child's exit.
    fn cleanup_structured_source(&self, child: &ChildRun) {
        if !child.sidechannel_owned {
            return;
        }
        if let Some(path) = child.sidechannel_file.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// User-supplied vitest flags otel-scrape must respect before injecting its own
/// side-channel flags (decision 0017 clause 2): a pre-existing `--outputFile.json`
/// (any form) is read in place instead of clobbered, and a pre-existing
/// `--reporter` is preserved instead of overridden.
struct VitestUserFlags {
    output_file_json: Option<PathBuf>,
    has_any_reporter: bool,
    has_json_reporter: bool,
}

/// Scan the child argv for the vitest flags that otel-scrape's side-channel would
/// otherwise clobber. Handles both `--flag=value` and `--flag value` forms.
fn scan_vitest_user_flags(argv: &[String]) -> VitestUserFlags {
    let mut output_file_json = None;
    let mut has_any_reporter = false;
    let mut has_json_reporter = false;
    let mut iter = argv.iter().peekable();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--outputFile.json=") {
            output_file_json = Some(PathBuf::from(value));
        } else if arg == "--outputFile.json" {
            // Bare form: the next arg is the path. Peek (don't consume) so it is
            // still forwarded to vitest unchanged.
            if let Some(value) = iter.peek() {
                output_file_json = Some(PathBuf::from(value.as_str()));
            }
        } else if let Some(value) = arg.strip_prefix("--reporter=") {
            has_any_reporter = true;
            has_json_reporter |= value == "json";
        } else if arg == "--reporter" {
            has_any_reporter = true;
            has_json_reporter |= iter.peek().map(|v| v.as_str()) == Some("json");
        }
    }
    VitestUserFlags {
        output_file_json,
        has_any_reporter,
        has_json_reporter,
    }
}

/// The subset of vitest's `--reporter=json` summary otel-scrape consumes from the
/// side-channel file. Counts only (decision 0017): no per-test names/files/errors.
#[derive(Debug, Deserialize)]
struct VitestJson {
    #[serde(rename = "numTotalTests", default)]
    num_total_tests: u64,
    #[serde(rename = "numFailedTests", default)]
    num_failed_tests: u64,
}

/// vitest side-channel adapter (decision 0017): parse the `--reporter=json`
/// report written to `--outputFile.json`. Public-safe count metrics only — no test
/// names, files, or failure messages cross a sink. Presentation is left to vitest's
/// own stdout (side-channel), so there is no render.
///
/// Returns `Err(reason)` when the side-channel is unavailable — a missing/empty
/// file (collapsed to empty bytes upstream) or unparseable JSON. `VitestJson` uses
/// `#[serde(default)]`, so without this guard an absent side-channel would silently
/// parse to `tests=0 / failures=0`; instead the caller WARNS and omits the metrics
/// rather than reporting misleading zeroes. A validly-parsed report with genuine
/// zero counts is `Ok` and IS emitted.
fn vitest_outputs(structured_source: &[u8]) -> Result<Vec<AdapterOutput>, &'static str> {
    if structured_source.is_empty() {
        return Err("no side-channel output (missing or empty file)");
    }
    let Ok(report) = serde_json::from_slice::<VitestJson>(structured_source) else {
        return Err("unparseable side-channel JSON");
    };
    Ok(vec![
        AdapterOutput::Metric(AdapterMetric {
            name: telemetry_registry::metrics::VITEST_TESTS,
            value: report.num_total_tests,
        }),
        AdapterOutput::Metric(AdapterMetric {
            name: telemetry_registry::metrics::VITEST_FAILURES,
            value: report.num_failed_tests,
        }),
    ])
}
