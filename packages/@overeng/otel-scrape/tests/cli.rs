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
