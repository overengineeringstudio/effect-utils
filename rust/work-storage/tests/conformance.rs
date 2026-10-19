use serde::Deserialize;
use serde_json::{json, Value};
use work_storage::{
    read_manifest, resolve_json, Manifest, Observation, Purpose, ReadManifestError, Response,
    StorageError, WorkStorage, PROTOCOL_SCHEMA,
};

#[derive(Deserialize)]
struct Case {
    name: String,
    request: Value,
    expected: Response,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/conformance.json")))
        .expect("shared conformance fixtures must decode")
}

#[test]
fn shared_wire_conformance() {
    let cases = cases();
    assert!(!cases.is_empty(), "shared conformance cases must not be empty");
    for case in cases {
        assert_eq!(
            resolve_json(&serde_json::to_string(&case.request).unwrap()),
            case.expected,
            "{}",
            case.name
        );
    }
}

#[test]
fn numeric_version_spellings_follow_json_schema_integer_semantics() {
    let request = serde_json::to_string(&cases()[0].request).unwrap();
    for version in ["1", "1.0", "1e0", "10e-1", "0.1e1"] {
        let request = request.replace("\"version\":1", &format!("\"version\":{version}"));
        assert!(matches!(resolve_json(&request), Response::Ok(_)), "{version}");
    }
}

#[test]
fn malformed_requests_are_invalid_before_admission() {
    for request in ["", "{", "null", "[]", "true", "{}"] {
        assert_eq!(resolve_json(request), Response::Error(StorageError::InvalidManifest));
    }
    let mut request = cases()[0].request.clone();
    request["observed"] = json!({"present": false});
    request["purpose"] = json!("unknown");
    assert_eq!(
        resolve_json(&request.to_string()),
        Response::Error(StorageError::InvalidManifest)
    );
}

#[test]
fn struct_sequences_and_provider_enum_objects_are_not_wire_objects() {
    let base = &cases()[0].request;
    let provider = &base["manifest"]["provider"];
    let mut requests = Vec::new();
    requests.push(json!([base["manifest"], base["observed"], base["purpose"]]));
    let mut request = base.clone();
    request["observed"] = json!([true, provider["identity"]]);
    requests.push(request);
    let mut request = base.clone();
    request["manifest"]["provider"] = json!([provider["kind"], provider["root"], provider["identity"]]);
    requests.push(request);
    let mut request = base.clone();
    request["manifest"]["provider"]["kind"] = json!({"apfs": null});
    requests.push(request);
    let mut request = base.clone();
    let manifest = &base["manifest"];
    request["manifest"] = json!([
        manifest["version"], manifest["app"], manifest["provider"],
        manifest["paths"], manifest["environment"]
    ]);
    requests.push(request);
    for request in requests {
        assert_eq!(resolve_json(&request.to_string()), Response::Error(StorageError::InvalidManifest));
    }
}

#[test]
fn typed_reader_preserves_declared_environment_and_roles() {
    let request = &cases()[0].request;
    let manifest = Manifest::from_json(&request["manifest"].to_string()).unwrap();
    let observed: Observation = serde_json::from_value(request["observed"].clone()).unwrap();
    let storage = WorkStorage::admit(manifest, &observed).unwrap();
    assert_eq!(storage.manifest().app(), "demo");
    assert_eq!(storage.role(Purpose::State).unwrap(), request["manifest"]["paths"]["state"]);
    assert_eq!(storage.environment()["XDG_STATE_HOME"], request["manifest"]["environment"]["XDG_STATE_HOME"]);
    assert_eq!(storage.resolve("unknown"), Err(StorageError::UnknownPurpose));
}

#[test]
fn response_serialization_is_the_portable_wire_shape() {
    assert_eq!(serde_json::to_value(Response::Ok("/demo".into())).unwrap(), json!({"ok": "/demo"}));
    assert_eq!(
        serde_json::to_value(Response::Error(StorageError::FactoryAbsent)).unwrap(),
        json!({"error": "FactoryAbsent"})
    );
}

#[test]
fn exported_schema_is_the_normative_manifest_contract() {
    let schema: Value = serde_json::from_str(PROTOCOL_SCHEMA).unwrap();
    assert_eq!(schema["$id"], "https://overengineering.studio/work-storage/v1/manifest.schema.json");
    assert_eq!(schema["properties"]["version"]["const"], 1);
}

#[test]
fn file_entrypoint_reads_only_manifest_and_preserves_io_errors() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.json");
    let request = &cases()[0].request;
    std::fs::write(&path, request["manifest"].to_string()).unwrap();
    let manifest = read_manifest(&path).unwrap();
    assert_eq!(manifest.app(), "demo");
    std::fs::write(&path, "not json").unwrap();
    assert!(matches!(read_manifest(&path), Err(ReadManifestError::InvalidManifest)));
    std::fs::write(&path, [0xff]).unwrap();
    assert!(matches!(read_manifest(&path), Err(ReadManifestError::InvalidManifest)));
    let error = read_manifest(directory.path().join("absent.json")).unwrap_err();
    match error {
        ReadManifestError::Io(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        ReadManifestError::InvalidManifest => panic!("missing manifest must preserve I/O failure"),
    }
}
