//! M10 contract hardening: --print-schema accuracy and sysexits coverage —
//! every own-failure exit code is provably reachable, so a harness can branch
//! on them.

use std::collections::BTreeSet;
use std::process::Command;

fn otelite() -> Command {
    Command::new(env!("CARGO_BIN_EXE_otelite"))
}

/// `--print-schema` lists exactly the schema tags the tool emits.
#[test]
fn print_schema_lists_all() {
    let out = otelite().arg("--print-schema").output().unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let got: BTreeSet<&str> = v["schemas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    let want: BTreeSet<&str> = [
        "otelite.endpoints/v1",
        "otelite.summary/v1",
        "otelite.span/v1",
        "otelite.trace-summary/v1",
        "otelite.metric/v1",
        "otelite.metric-summary/v1",
        "otelite.log/v1",
        "otelite.log-summary/v1",
    ]
    .into_iter()
    .collect();
    assert_eq!(got, want);
}

fn code(c: Command) -> i32 {
    let mut c = c;
    c.output().unwrap().status.code().unwrap()
}

/// Each own-failure sysexits code is reachable and distinct.
#[test]
fn sysexits_coverage() {
    // 64 — usage: unknown flag.
    let mut bad_flag = otelite();
    bad_flag.args(["run", "--bogus", "--", "true"]);
    assert_eq!(code(bad_flag), 64);

    // 66 — missing inspect source.
    let mut missing = otelite();
    missing.args(["inspect", "/no/such/dir"]);
    assert_eq!(code(missing), 66);

    // 65 — corrupt capture.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("traces.ndjson"), "not json\n").unwrap();
    let mut corrupt = otelite();
    corrupt.arg("inspect").arg(dir.path());
    assert_eq!(code(corrupt), 65);

    // 73 — out-dir cannot be created (parent is a file).
    let f = tempfile::NamedTempFile::new().unwrap();
    let mut bad_out = otelite();
    bad_out
        .args(["run", "--out"])
        .arg(f.path().join("sub"))
        .args(["--", "true"]);
    assert_eq!(code(bad_out), 73);

    // 74 — shared out-dir: a capture file already exists (O_EXCL).
    let dir2 = tempfile::tempdir().unwrap();
    std::fs::write(dir2.path().join("traces.ndjson"), "").unwrap();
    let mut shared = otelite();
    shared
        .args(["run", "--out"])
        .arg(dir2.path())
        .args(["--", "true"]);
    assert_eq!(code(shared), 74);
}
