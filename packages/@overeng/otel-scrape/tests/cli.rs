use std::{
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    thread,
};

use sha2::{Digest, Sha256};

fn otel_scrape() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_otel-scrape"));
    command
        .env_remove("OTEL_EXPORTER_OTLP_ENDPOINT")
        .env_remove("OTEL_SERVICE_NAME");
    command
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
    assert_eq!(summary["adapter"]["name"], "none");
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(summary["output"]["stdout"], serde_json::Value::Null);
    assert_eq!(summary["output"]["stderr"], serde_json::Value::Null);
    assert!(summary["resources"]["wallMs"].as_u64().is_some());
    assert_eq!(summary["resources"]["cpuTimeMs"], serde_json::Value::Null);
    assert_eq!(summary["resources"]["maxRssBytes"], serde_json::Value::Null);
    assert_eq!(
        summary["resources"]["availability"]["cpuTime"],
        "unavailable"
    );
    assert_eq!(
        summary["resources"]["availability"]["maxRss"],
        "unavailable"
    );
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    assert!(summary["command"]["argv_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(summary["command"].get("argv").is_none());
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["processes"]["reason"], "direct-child-only");
    assert_eq!(
        summary["processes"]["observed"].as_array().unwrap().len(),
        1
    );
    let process = &summary["processes"]["observed"][0];
    assert_eq!(process["_tag"], "Process");
    assert_eq!(process["relation"], "direct-child");
    assert_eq!(process["parentSpanId"], summary["trace"]["span_id"]);
    assert!(process["spanId"].as_str().unwrap().len() == 16);
    assert!(process["pidHash"].as_str().unwrap().starts_with("sha256:"));
    assert!(process["parentPidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(process["argvHash"], summary["command"]["argv_hash"]);
    assert_eq!(process["exitCode"], 7);
    assert!(process["startUnixNano"].as_u64().is_some());
    assert!(process["endUnixNano"].as_u64().is_some());
    assert!(process.get("pid").is_none());
    assert!(process.get("parentPid").is_none());
    assert!(process.get("argv").is_none());
}

#[test]
fn oxlint_adapter_parses_json_diagnostics_without_hiding_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let oxlint_json = r#"{ "privatePayload": "PRIVATE_OUTPUT_PAYLOAD", "diagnostics": [{"message": "Unexpected token","severity": "error","filename": "/private/source.ts"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), oxlint_json);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "oxlint");
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(summary["adapter"]["records"][0]["_tag"], "Metric");
    assert_eq!(
        summary["adapter"]["records"][0]["name"],
        "oxlint.diagnostics"
    );
    assert_eq!(summary["adapter"]["records"][0]["value"], 1);
    assert_eq!(summary["output"]["stdout"]["_tag"], "ContentDescriptor");
    assert!(summary["output"]["stdout"]["digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(
        summary["output"]["stdout"]["byteLength"],
        oxlint_json.as_bytes().len()
    );
    assert_eq!(
        summary["output"]["stdout"]["mediaType"],
        "application/octet-stream"
    );
    assert_eq!(summary["output"]["stderr"]["_tag"], "ContentDescriptor");
    assert_eq!(summary["output"]["stderr"]["byteLength"], 0);
    assert_eq!(
        summary["output"]["stderr"]["mediaType"],
        "application/octet-stream"
    );
    assert_eq!(summary["adapter"]["records"][1]["_tag"], "Event");
    assert_eq!(
        summary["adapter"]["records"][1]["message"],
        "Unexpected token"
    );
    assert_eq!(summary["adapter"]["records"][1]["severity"], "error");
    assert!(summary["adapter"]["records"][1]["filename_hash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(summary["adapter"]["records"][1].get("filename").is_none());
    let summary_json = serde_json::to_string(&summary).unwrap();
    assert!(!summary_json.contains("/private/source.ts"));
    assert!(!summary_json.contains("PRIVATE_OUTPUT_PAYLOAD"));
}

#[test]
fn oxlint_adapter_parse_failure_preserves_output_and_exit_status() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let invalid_json = "{not-json";

    let out = otel_scrape()
        .env("OX_JSON", invalid_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\"; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), invalid_json);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["child"]["exit_code"], 7);
    assert_eq!(summary["adapter"]["name"], "oxlint");
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(
        summary["output"]["stdout"]["byteLength"],
        invalid_json.as_bytes().len()
    );
}

#[test]
fn oxlint_adapter_does_not_turn_plain_output_lines_into_spans() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let plain_output = "line one\nline two\nline three\n";

    let out = otel_scrape()
        .env("PLAIN_OUTPUT", plain_output)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "printf '%s' \"$PLAIN_OUTPUT\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), plain_output);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    let records = summary["adapter"]["records"].as_array().unwrap();
    assert!(records
        .iter()
        .all(|record| record["_tag"] == "Event" || record["_tag"] == "Metric"));
    assert_eq!(records.len(), 0);
}

#[test]
fn parent_wrapper_preserves_nested_output_without_reclassifying_child_owned_adapter_records() {
    let dir = tempfile::tempdir().unwrap();
    let outer_summary = dir.path().join("outer-summary.json");
    let inner_summary = dir.path().join("inner-summary.json");
    let oxlint_json = r#"{ "diagnostics": [{"message": "Nested diagnostic","severity": "warning","filename": "nested.ts"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&outer_summary)
        .args(["--", env!("CARGO_BIN_EXE_otel-scrape")])
        .args(["--adapter", "oxlint", "--summary-out"])
        .arg(&inner_summary)
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), oxlint_json);

    let outer: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(outer_summary).unwrap()).unwrap();
    let inner: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(inner_summary).unwrap()).unwrap();

    assert_eq!(outer["adapter"]["name"], "oxlint");
    assert_eq!(outer["adapter"]["ownership"]["stdout"], "child-wrapper");
    assert_eq!(outer["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(outer["output"]["stdout"]["_tag"], "ContentDescriptor");
    assert_eq!(
        outer["output"]["stdout"]["byteLength"],
        oxlint_json.as_bytes().len()
    );

    assert_eq!(inner["adapter"]["name"], "oxlint");
    assert_eq!(inner["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(inner["adapter"]["records"][0]["_tag"], "Metric");
    assert_eq!(inner["adapter"]["records"][1]["_tag"], "Event");

    assert_eq!(outer["trace"]["trace_id"], inner["trace"]["trace_id"]);
    assert_eq!(inner["trace"]["parent_span_id"], outer["trace"]["span_id"]);
    assert_ne!(
        outer["trace"]["child_traceparent"],
        inner["trace"]["child_traceparent"]
    );
}

#[test]
fn profile_artifact_writes_cas_object_manifest_pin_and_profile_record() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let profile = dir.path().join("profile.cpuprofile");
    std::fs::write(&profile, b"profile-bytes").unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .args(["--cas-pin", "runs/run-1"])
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["records"].as_array().unwrap().len(), 0);
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    let profile_link = &summary["artifacts"]["profiles"][0];
    assert_eq!(profile_link["type"], "cpuprofile");
    assert_eq!(profile_link["byteLength"], 13);
    assert_eq!(profile_link["mediaType"], "application/octet-stream");
    assert!(profile_link["digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(profile_link["uri"]
        .as_str()
        .unwrap()
        .starts_with("cas:sha256/"));
    assert!(profile_link.get("path").is_none());
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(profile.to_string_lossy().as_ref()));

    let object_path = profile_link["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("cas:")
        .unwrap();
    assert_eq!(
        std::fs::read(cas_root.join(object_path)).unwrap(),
        b"profile-bytes"
    );

    let pin: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(cas_root.join("pins/runs/run-1")).unwrap())
            .unwrap();
    assert_eq!(pin["_tag"], "ContentPin");
    assert_eq!(pin["schemaVersion"], 1);
    assert_eq!(pin["target"]["mediaType"], "application/json");
    assert_eq!(pin["target"]["codec"], "canonical-json");
    assert_eq!(pin["target"]["schemaVersion"], 1);
    assert_eq!(
        summary["artifacts"]["manifest"]["digest"],
        pin["target"]["digest"]
    );
    assert_eq!(summary["artifacts"]["manifest"]["pin"], "runs/run-1");
    assert_eq!(summary["artifacts"]["manifest"]["entryCount"], 1);

    let manifest_digest = pin["target"]["digest"].as_str().unwrap();
    let manifest_object_path = format!(
        "sha256/{}/{}",
        &manifest_digest["sha256:".len().."sha256:".len() + 2],
        &manifest_digest["sha256:".len() + 2..]
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(cas_root.join(manifest_object_path)).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["_tag"], "ContentManifest");
    assert_eq!(manifest["role"], "otel-scrape-run");
    assert_eq!(
        manifest["entries"][0]["descriptor"]["digest"],
        profile_link["digest"]
    );
    assert_eq!(
        manifest["entries"][0]["logicalPath"],
        "profiles/0-cpuprofile"
    );
    assert_eq!(manifest["entries"][0]["role"], "profile");
}

#[test]
fn missing_profile_artifact_is_structured_degraded_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let missing_profile = dir.path().join("missing.cpuprofile");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", missing_profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    let error = &summary["artifacts"]["errors"][0];
    assert_eq!(error["profileType"], "cpuprofile");
    assert!(error["pathHash"].as_str().unwrap().starts_with("sha256:"));
    assert!(error["message"]
        .as_str()
        .unwrap()
        .starts_with("failed to read profile artifact:"));
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(missing_profile.to_string_lossy().as_ref()));
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
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to write summary target sha256:"));
    assert!(!stderr.contains(summary_path_is_directory.to_string_lossy().as_ref()));
    let leftover_temp_files = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("summary-target.tmp-")
        })
        .count();
    assert_eq!(leftover_temp_files, 0);
}

#[cfg(unix)]
#[test]
fn signal_termination_preserves_synthetic_exit_code_and_summary_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--", "sh", "-c", "kill -TERM $$"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(143));

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["child"]["exit_code"], serde_json::Value::Null);
    assert_eq!(summary["child"]["success"], false);
    assert_eq!(summary["child"]["termination"]["_tag"], "Signal");
    assert_eq!(summary["child"]["termination"]["signal"], 15);
    assert_eq!(summary["child"]["termination"]["synthetic_exit_code"], 143);
}

#[test]
fn process_observation_fixture_marks_descendant_workload_as_direct_child_only() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let descendant_marker = dir.path().join("descendant-ran");

    let out = otel_scrape()
        .env("DESCENDANT_MARKER", &descendant_marker)
        .args(["--summary-out"])
        .arg(&summary)
        .args([
            "--",
            "sh",
            "-c",
            "sh -c 'printf descendant > \"$DESCENDANT_MARKER\"'; printf parent",
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "parent");
    assert_eq!(
        std::fs::read_to_string(descendant_marker).unwrap(),
        "descendant"
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["degraded"]["direct_child_only"], true);
    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert_eq!(observed[0]["parentSpanId"], summary["trace"]["span_id"]);
    assert!(observed[0]["pidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[cfg(unix)]
#[test]
fn compiled_process_dag_fixture_gates_descendant_exactness_claims() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let expected_dag = dir.path().join("expected-dag.json");
    let grandchild_record = dir.path().join("grandchild.json");
    let fixture = compile_process_dag_fixture(dir.path());

    let out = otel_scrape()
        .env("OTEL_SCRAPE_EXPECTED_DAG", &expected_dag)
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--"])
        .arg(&fixture)
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "fixture-done");

    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(expected_dag).unwrap()).unwrap();
    assert!(expected["rootPid"].as_u64().is_some());
    let expected_children = expected["children"].as_array().unwrap();
    assert_eq!(expected_children.len(), 3);
    assert_eq!(expected_children[0]["parentPid"], expected["rootPid"]);
    assert_eq!(expected_children[1]["parentPid"], expected["rootPid"]);
    assert_eq!(
        expected_children[2]["parentPid"],
        expected_children[1]["pid"]
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "direct-child");
    assert_eq!(summary["processes"]["fidelity"], "degraded");
    assert_eq!(summary["processes"]["reason"], "direct-child-only");
    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert!(observed[0]["pidHash"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
}

#[cfg(target_os = "linux")]
#[test]
fn ptrace_experimental_process_backend_observes_fixture_dag() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let expected_dag = dir.path().join("expected-dag.json");
    let grandchild_record = dir.path().join("grandchild.json");
    let fixture = compile_process_dag_fixture(dir.path());

    let out = otel_scrape()
        .env("OTEL_SCRAPE_EXPECTED_DAG", &expected_dag)
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--process-backend", "ptrace-experimental"])
        .args(["--"])
        .arg(&fixture)
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "fixture-done");

    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(expected_dag).unwrap()).unwrap();
    let expected_root_hash = stable_hash(expected["rootPid"].as_u64().unwrap().to_string());
    let expected_children = expected["children"].as_array().unwrap();
    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["processes"]["backend"], "ptrace-experimental");
    assert_eq!(summary["processes"]["fidelity"], "exact");
    assert_eq!(summary["processes"]["reason"], serde_json::Value::Null);
    assert_eq!(summary["degraded"]["direct_child_only"], false);

    let observed = summary["processes"]["observed"].as_array().unwrap();
    assert_eq!(observed.len(), 4);
    assert_eq!(observed[0]["relation"], "direct-child");
    assert_eq!(observed[0]["pidHash"], expected_root_hash);
    assert_eq!(observed[0]["parentSpanId"], summary["trace"]["span_id"]);
    let root_span_id = observed[0]["spanId"].clone();

    for expected_child in expected_children {
        let pid_hash = stable_hash(expected_child["pid"].as_u64().unwrap().to_string());
        let parent_pid_hash =
            stable_hash(expected_child["parentPid"].as_u64().unwrap().to_string());
        let observed_child = observed
            .iter()
            .find(|process| process["pidHash"] == pid_hash)
            .unwrap_or_else(|| panic!("missing observed child with pid hash {pid_hash}"));
        assert_eq!(observed_child["parentPidHash"], parent_pid_hash);
        assert_eq!(
            observed_child["exitCode"],
            expected_child["exitCode"].as_i64().unwrap()
        );
        assert_eq!(observed_child["relation"], "descendant");
        match expected_child["role"].as_str().unwrap() {
            "immediate-exit" | "nested-parent" => {
                assert_eq!(observed_child["parentSpanId"], root_span_id);
            }
            "grandchild" => {
                assert!(observed_child["parentSpanId"].as_str().is_some());
                assert_ne!(observed_child["parentSpanId"], root_span_id);
            }
            role => panic!("unexpected fixture role {role}"),
        }
    }
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

#[cfg(unix)]
fn compile_process_dag_fixture(dir: &Path) -> PathBuf {
    let source = dir.join("process_dag_fixture.rs");
    let binary = dir.join("process-dag-fixture");
    std::fs::write(
        &source,
        r##"
use std::io::Write;
use std::process::{Command, Stdio};

fn main() {
    if std::env::var("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD").is_ok() {
        std::process::exit(0);
    }

    if std::env::var("OTEL_SCRAPE_PROCESS_DAG_NESTED_PARENT").is_ok() {
        let child = Command::new(std::env::current_exe().unwrap())
            .env("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let grandchild_pid = child.id();
        let status = child.wait_with_output().unwrap().status;
        let record_path = std::env::var("OTEL_SCRAPE_GRANDCHILD_RECORD").unwrap();
        std::fs::write(
            record_path,
            format!(
                r#"{{"role":"grandchild","pid":{},"parentPid":{},"exitCode":{}}}"#,
                grandchild_pid,
                std::process::id(),
                status.code().unwrap_or(-1)
            ),
        )
        .unwrap();
        std::process::exit(0);
    }

    let expected_path = std::env::var("OTEL_SCRAPE_EXPECTED_DAG").unwrap();
    let grandchild_record_path = std::env::var("OTEL_SCRAPE_GRANDCHILD_RECORD").unwrap();
    let root_pid = std::process::id();
    let mut children = Vec::new();

    let immediate = Command::new(std::env::current_exe().unwrap())
        .env("OTEL_SCRAPE_PROCESS_DAG_GRANDCHILD", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let immediate_pid = immediate.id();
    let immediate_status = immediate.wait_with_output().unwrap().status;
    children.push(format!(
        r#"{{"role":"immediate-exit","pid":{},"parentPid":{},"exitCode":{}}}"#,
        immediate_pid,
        root_pid,
        immediate_status.code().unwrap_or(-1)
    ));

    let nested = Command::new(std::env::current_exe().unwrap())
        .env("OTEL_SCRAPE_PROCESS_DAG_NESTED_PARENT", "1")
        .env("OTEL_SCRAPE_GRANDCHILD_RECORD", &grandchild_record_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let nested_pid = nested.id();
    let nested_status = nested.wait_with_output().unwrap().status;
    children.push(format!(
        r#"{{"role":"nested-parent","pid":{},"parentPid":{},"exitCode":{}}}"#,
        nested_pid,
        root_pid,
        nested_status.code().unwrap_or(-1)
    ));
    children.push(std::fs::read_to_string(grandchild_record_path).unwrap());

    let json = format!(
        r#"{{"rootPid":{},"children":[{}]}}"#,
        root_pid,
        children.join(",")
    );
    std::fs::write(expected_path, json).unwrap();
    std::io::stdout().write_all(b"fixture-done").unwrap();
}
"##,
    )
    .unwrap();
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    let status = Command::new(rustc)
        .arg("--edition=2021")
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .unwrap();
    assert!(status.success());
    binary
}

fn stable_hash(value: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_ref());
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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

#[test]
fn exports_command_span_to_otlp_http_json() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let parent = "00-11111111111111111111111111111111-2222222222222222-01";

    let out = otel_scrape()
        .env("traceparent", parent)
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--service-name", "otel-scrape-test"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
    assert_eq!(request.content_type.as_deref(), Some("application/json"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let resource_span = &body["resourceSpans"][0];
    assert_eq!(
        attr_value(
            resource_span["resource"]["attributes"].as_array().unwrap(),
            "service.name"
        ),
        Some("otel-scrape-test".to_owned())
    );
    let span = &resource_span["scopeSpans"][0]["spans"][0];
    assert_eq!(span["name"], "otel_scrape.command");
    assert_eq!(span["traceId"], "11111111111111111111111111111111");
    assert_eq!(span["parentSpanId"], "2222222222222222");
    assert_eq!(span["spanId"], summary["trace"]["span_id"]);
    assert_eq!(span["status"]["code"], 1);
    let attrs = span["attributes"].as_array().unwrap();
    assert!(attr_value(attrs, "process.command_args_hash")
        .unwrap()
        .starts_with("sha256:"));
    assert_eq!(attr_value(attrs, "process.exit_code"), Some("0".to_owned()));
    assert_eq!(
        attr_value(attrs, "otel_scrape.adapter.name"),
        Some("none".to_owned())
    );
    let spans = resource_span["scopeSpans"][0]["spans"].as_array().unwrap();
    assert_eq!(spans.len(), 2);
    let process_span = spans
        .iter()
        .find(|span| span["name"] == "otel_scrape.process")
        .unwrap();
    assert_eq!(process_span["traceId"], span["traceId"]);
    assert_eq!(process_span["parentSpanId"], span["spanId"]);
    assert_eq!(
        process_span["spanId"],
        summary["processes"]["observed"][0]["spanId"]
    );
    let process_attrs = process_span["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(process_attrs, "process.command_args_hash"),
        summary["command"]["argv_hash"]
            .as_str()
            .map(ToOwned::to_owned)
    );
    assert_eq!(
        attr_value(process_attrs, "process.exit_code"),
        Some("0".to_owned())
    );
    assert_eq!(
        attr_value(process_attrs, "otel_scrape.process.observation.backend"),
        Some("direct-child".to_owned())
    );
    assert_eq!(
        attr_value(process_attrs, "otel_scrape.process.observation.fidelity"),
        Some("degraded".to_owned())
    );
    assert_eq!(
        attr_value(process_attrs, "otel_scrape.process.observation.relation"),
        Some("direct-child".to_owned())
    );
}

#[test]
fn otlp_export_failure_preserves_child_exit_code() {
    let collector = TestCollector::start(500);
    let endpoint = format!("{}/tokenized-secret-path", collector.endpoint);

    let out = otel_scrape()
        .args(["--otlp-endpoint", &endpoint])
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace"));
    assert!(!stderr.contains("tokenized-secret-path"));
    let request = collector.request();
    assert_eq!(request.path, "/tokenized-secret-path");
}

#[test]
fn otlp_export_timeout_preserves_child_exit_code_when_collector_stalls() {
    let collector = TestCollector::start_stalling();

    let out = otel_scrape()
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace"));
    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
}

#[test]
fn otlp_export_warning_does_not_leak_invalid_env_endpoint() {
    let out = otel_scrape()
        .env(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "http://user:SECRET@127.0.0.1:9/private-token?token=SECRET",
        )
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("failed to export OTLP trace to <invalid http endpoint>"));
    assert!(!stderr.contains("SECRET"));
    assert!(!stderr.contains("private-token"));
    assert!(!stderr.contains("user:"));
}

#[test]
fn exports_oxlint_adapter_event_without_raw_filename_or_payload() {
    let collector = TestCollector::start(200);
    let oxlint_json = r#"{ "privatePayload": "PRIVATE_OUTPUT_PAYLOAD", "diagnostics": [{"message": "Unexpected token","severity": "error","filename": "/private/source.ts"}] }"#;

    let out = otel_scrape()
        .env("OX_JSON", oxlint_json)
        .args(["--adapter", "oxlint"])
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf '%s' \"$OX_JSON\""])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), oxlint_json);

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!body_json.contains("/private/source.ts"));
    assert!(!body_json.contains("PRIVATE_OUTPUT_PAYLOAD"));
    assert!(!body_json.contains("Unexpected token"));
    assert!(body_json.contains("otel_scrape.adapter.event"));
    assert!(!body_json.contains("oxlint.diagnostics"));
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.adapter.event")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(attr_value(attrs, "severity"), Some("error".to_owned()));
    assert!(attr_value(attrs, "source.filename_hash")
        .unwrap()
        .starts_with("sha256:"));
}

#[test]
fn exports_profile_link_event_without_duplicate_cas_writes_or_path_bytes() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let profile = dir.path().join("private-profile.cpuprofile");
    std::fs::write(&profile, b"PRIVATE_PROFILE_BYTES").unwrap();

    let out = otel_scrape()
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--cas-root"])
        .arg(&cas_root)
        .arg("--profile-artifact")
        .arg(format!("cpuprofile:{}", profile.display()))
        .args(["--", "sh", "-c", "printf child"])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!body_json.contains(profile.to_string_lossy().as_ref()));
    assert!(!body_json.contains("PRIVATE_PROFILE_BYTES"));
    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.profile.link")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(attrs, "profile.type"),
        Some("cpuprofile".to_owned())
    );
    assert!(attr_value(attrs, "profile.digest")
        .unwrap()
        .starts_with("sha256:"));
    assert!(attr_value(attrs, "profile.uri")
        .unwrap()
        .starts_with("cas:sha256/"));
    assert_eq!(attr_value(attrs, "byteLength"), Some("21".to_owned()));
    assert_eq!(
        attr_value(attrs, "mediaType"),
        Some("application/octet-stream".to_owned())
    );

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(
        attr_value(attrs, "profile.digest"),
        summary["artifacts"]["profiles"][0]["digest"]
            .as_str()
            .map(ToOwned::to_owned)
    );
    let objects = std::fs::read_dir(cas_root.join("sha256"))
        .unwrap()
        .flat_map(|prefix| std::fs::read_dir(prefix.unwrap().path()).unwrap())
        .count();
    assert_eq!(objects, 2);
}

#[test]
fn node_cpuprofile_adapter_writes_resolvable_profile_without_leaking_private_inputs() {
    let collector = TestCollector::start(200);
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let private_arg = "PRIVATE_ARG_MARKER";

    let out = otel_scrape()
        .args(["--adapter", "node-cpuprofile"])
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--cas-root"])
        .arg(&cas_root)
        .args([
            "--",
            "node",
            "-e",
            "for (let i = 0; i < 100000; i++) Math.sqrt(i); console.log(process.argv[1])",
            private_arg,
        ])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "PRIVATE_ARG_MARKER\n");

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "node-cpuprofile");
    assert_eq!(summary["adapter"]["ownership"]["stdout"], "this-wrapper");
    assert_eq!(summary["artifacts"]["errors"].as_array().unwrap().len(), 0);
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        1
    );
    let profile_link = &summary["artifacts"]["profiles"][0];
    assert_eq!(profile_link["type"], "cpuprofile");
    assert!(profile_link["byteLength"].as_u64().unwrap() > 0);
    assert_eq!(profile_link["mediaType"], "application/octet-stream");
    assert!(profile_link["digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(profile_link["uri"]
        .as_str()
        .unwrap()
        .starts_with("cas:sha256/"));
    assert_eq!(summary["artifacts"]["manifest"]["entryCount"], 1);

    let object_path = profile_link["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("cas:")
        .unwrap();
    let profile_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cas_root.join(object_path)).unwrap()).unwrap();
    assert!(profile_json["nodes"].as_array().unwrap().len() > 0);
    assert!(profile_json["samples"].as_array().is_some());

    let request = collector.request();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    let summary_json = serde_json::to_string(&summary).unwrap();
    let body_json = serde_json::to_string(&body).unwrap();
    assert!(!summary_json.contains(private_arg));
    assert!(!summary_json.contains("100000"));
    assert!(!body_json.contains(private_arg));
    assert!(!body_json.contains("100000"));

    let span = &body["resourceSpans"][0]["scopeSpans"][0]["spans"][0];
    let events = span["events"].as_array().unwrap();
    let event = events
        .iter()
        .find(|event| event["name"] == "otel_scrape.profile.link")
        .unwrap();
    assert_event_time_within_span(event, span);
    let attrs = event["attributes"].as_array().unwrap();
    assert_eq!(
        attr_value(attrs, "profile.type"),
        Some("cpuprofile".to_owned())
    );
    assert_eq!(
        attr_value(attrs, "profile.digest"),
        profile_link["digest"].as_str().map(ToOwned::to_owned)
    );
    assert_eq!(
        attr_value(attrs, "profile.uri"),
        profile_link["uri"].as_str().map(ToOwned::to_owned)
    );
}

#[test]
fn node_cpuprofile_adapter_degrades_for_non_node_child_without_raw_command() {
    let dir = tempfile::tempdir().unwrap();
    let summary = dir.path().join("summary.json");
    let cas_root = dir.path().join("cas");
    let private_arg = "PRIVATE_NON_NODE_ARG";

    let out = otel_scrape()
        .args(["--adapter", "node-cpuprofile"])
        .args(["--summary-out"])
        .arg(&summary)
        .args(["--cas-root"])
        .arg(&cas_root)
        .args(["--", "sh", "-c", "printf '%s' \"$1\"", "sh", private_arg])
        .output()
        .unwrap();

    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), private_arg);

    let summary: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(summary).unwrap()).unwrap();
    assert_eq!(summary["adapter"]["name"], "node-cpuprofile");
    assert_eq!(
        summary["artifacts"]["profiles"].as_array().unwrap().len(),
        0
    );
    assert_eq!(summary["artifacts"]["manifest"], serde_json::Value::Null);
    let error = &summary["artifacts"]["errors"][0];
    assert_eq!(error["profileType"], "cpuprofile");
    assert_eq!(error["pathHash"], serde_json::Value::Null);
    assert_eq!(
        error["message"],
        "node-cpuprofile adapter degraded: child command is not node"
    );
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains(private_arg));
}

fn attr_value(attrs: &[serde_json::Value], key: &str) -> Option<String> {
    attrs
        .iter()
        .find(|attr| attr["key"] == key)?
        .get("value")
        .and_then(|value| {
            value
                .get("stringValue")
                .or_else(|| value.get("intValue"))
                .or_else(|| value.get("doubleValue"))
                .or_else(|| value.get("boolValue"))
        })
        .and_then(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| Some(value.to_string()))
        })
}

fn assert_event_time_within_span(event: &serde_json::Value, span: &serde_json::Value) {
    let event_time = event["timeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let span_start = span["startTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let span_end = span["endTimeUnixNano"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    assert!(
        event_time >= span_start,
        "event timestamp {event_time} should be >= span start {span_start}"
    );
    assert!(
        event_time <= span_end,
        "event timestamp {event_time} should be <= span end {span_end}"
    );
}

struct TestCollector {
    endpoint: String,
    request_rx: mpsc::Receiver<CapturedRequest>,
}

struct CapturedRequest {
    path: String,
    content_type: Option<String>,
    body: Vec<u8>,
}

impl TestCollector {
    fn start(status: u16) -> Self {
        Self::start_with_response(Some(status))
    }

    fn start_stalling() -> Self {
        Self::start_with_response(None)
    }

    fn start_with_response(status: Option<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read]);
                if captured_request(&bytes).is_some() {
                    break;
                }
            }
            let request = captured_request(&bytes).unwrap();
            request_tx.send(request).unwrap();
            if let Some(status) = status {
                let response = format!(
                    "HTTP/1.1 {status} test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
                stream.write_all(response.as_bytes()).unwrap();
            } else {
                thread::sleep(std::time::Duration::from_secs(2));
            }
        });
        Self {
            endpoint,
            request_rx,
        }
    }

    fn request(self) -> CapturedRequest {
        self.request_rx.recv().unwrap()
    }
}

fn captured_request(bytes: &[u8]) -> Option<CapturedRequest> {
    let headers_end = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&bytes[..headers_end]).ok()?;
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .and_then(|value| value.parse::<usize>().ok())?;
    let body_start = headers_end + 4;
    if bytes.len() < body_start + content_length {
        return None;
    }
    let mut lines = headers.lines();
    let request_line = lines.next()?;
    let path = request_line.split_whitespace().nth(1)?.to_owned();
    let content_type = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Type: "))
        .map(ToOwned::to_owned);
    Some(CapturedRequest {
        path,
        content_type,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}
