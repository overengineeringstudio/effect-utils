//! Conformance goldens for the `inspect` core.
//!
//! `mocks/trace.json` is OTLP/JSON (the bytes an otelite capture line carries);
//! `golden.json` is the canonical output of `parse_otlp_trace` (inspect) or
//! `summarize_trace` (summarize). Each test feeds the input through the real
//! functions and compares byte-for-byte against the golden.
//!
//! Fixtures are resolved relative to `CARGO_MANIFEST_DIR` (no absolute paths).
//!
//! Regen guard: by default the tests compare only. Set `UPDATE_GOLDENS=1` to
//! rewrite the `golden.json` files from current output instead of asserting.

use std::path::PathBuf;

use otelite::inspect::canonical::canonical;
use otelite::inspect::{parse_otlp_trace, summarize_trace};
use serde_json::Value;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("conformance")
        .join("fixtures")
        .join("otel-cli")
}

fn load(rel: &str) -> Value {
    let p = fixtures_dir().join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p:?}: {e}")))
        .unwrap()
}

fn golden_path(case: &str) -> PathBuf {
    fixtures_dir().join(case).join("golden.json")
}

/// Compare `got` against the case's golden, or rewrite it when
/// `UPDATE_GOLDENS=1`.
fn check_golden(case: &str, got: &str) {
    let p = golden_path(case);
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
        // Match the on-disk shape: canonical JSON + trailing newline.
        std::fs::write(&p, format!("{got}\n")).unwrap_or_else(|e| panic!("{p:?}: {e}"));
        return;
    }
    let want = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("{p:?}: {e}"))
        .trim()
        .to_string();
    assert_eq!(got, want, "golden mismatch for {case}");
}

/// Pull the 32-hex trace id out of `args.toml` (`args = [..., "<id>", ...]`).
fn trace_id_from_args(case: &str) -> String {
    let p = fixtures_dir().join(case).join("args.toml");
    let txt = std::fs::read_to_string(&p).unwrap();
    txt.split('"')
        .find(|t| t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap()
        .to_string()
}

#[test]
fn trace_inspect_basic_matches_golden() {
    let case = "trace-inspect-basic";
    let id = trace_id_from_args(case);
    let input = load("trace-inspect-basic/mocks/trace.json");
    let snapshot = parse_otlp_trace(&input, &id);
    let got = canonical(&serde_json::to_value(&snapshot).unwrap());
    check_golden(case, &got);
}

#[test]
fn trace_summarize_json_matches_golden() {
    // args.toml: ["trace", "summarize", "<id>", "--top", "2"]
    let case = "trace-summarize-json";
    let id = trace_id_from_args(case);
    let input = load("trace-summarize-json/mocks/trace.json");
    let snapshot = parse_otlp_trace(&input, &id);
    let got = canonical(&summarize_trace(&snapshot, 2));
    check_golden(case, &got);
}
