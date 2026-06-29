use std::process::Command;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
};

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
}

#[test]
fn otlp_export_failure_preserves_child_exit_code() {
    let collector = TestCollector::start(500);

    let out = otel_scrape()
        .args(["--otlp-endpoint", &collector.endpoint])
        .args(["--", "sh", "-c", "printf child; exit 7"])
        .output()
        .unwrap();

    assert_eq!(out.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "child");
    assert!(String::from_utf8_lossy(&out.stderr).contains("failed to export OTLP trace"));
    let request = collector.request();
    assert_eq!(request.path, "/v1/traces");
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
            let response = format!(
                "HTTP/1.1 {status} test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
            stream.write_all(response.as_bytes()).unwrap();
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
