use std::process::Command;

fn otel_scrape() -> Command {
    Command::new(env!("CARGO_BIN_EXE_otel-scrape"))
}

#[test]
fn preserves_passthrough_and_writes_summary() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "echo child-out; echo child-err >&2; exit 7",
        ])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child-out\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "child-err\n");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["schema"], "otel-scrape.summary/v1");
    assert_eq!(summary["child"]["exit_code"], 7);
    assert_eq!(summary["command"]["adapter"], "none");
    assert!(summary["command"]["argv_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(summary["command"].get("argv").is_none());
}

#[test]
fn summary_write_failure_preserves_child_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let summary_path_is_directory = dir.path().join("summary-target");
    std::fs::create_dir(&summary_path_is_directory).unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary_path_is_directory)
        .args(["--", "sh", "-c", "echo child-out; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child-out\n");
    assert!(String::from_utf8_lossy(&out.stderr).contains("failed to write summary"));
}

#[test]
fn exports_root_traceparent_to_child() {
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join("traceparent");
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .env_remove("traceparent")
        .env_remove("TRACEPARENT")
        .env("ENV_FILE", &env_file)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "printf '%s' \"$traceparent\" > \"$ENV_FILE\"",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    let child_traceparent = std::fs::read_to_string(env_file).unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();

    assert_eq!(summary["trace"]["parent_span_id"], serde_json::Value::Null);
    assert_eq!(summary["trace"]["child_traceparent"], child_traceparent);
    assert!(child_traceparent.starts_with("00-"));
}

#[test]
fn joins_parent_traceparent() {
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join("traceparent");
    let summary = dir.path().join("summary.json");
    let parent = "00-11111111111111111111111111111111-2222222222222222-01";

    let out = otel_scrape()
        .env("traceparent", parent)
        .env("ENV_FILE", &env_file)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "printf '%s' \"$traceparent\" > \"$ENV_FILE\"",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    let child_traceparent = std::fs::read_to_string(env_file).unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();

    assert_eq!(
        summary["trace"]["trace_id"],
        "11111111111111111111111111111111"
    );
    assert_eq!(summary["trace"]["parent_span_id"], "2222222222222222");
    assert_eq!(summary["trace"]["child_traceparent"], child_traceparent);
    assert_ne!(child_traceparent, parent);
}
