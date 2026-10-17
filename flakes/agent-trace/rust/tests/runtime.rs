use agent_trace::{
    capture_artifact, AgentTraceRuntimeV1, AgentTraceV2, ArtifactFacts, CaptureError,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn corpus() -> Value {
    serde_json::from_str(include_str!("../../fixtures/codec-corpus.json")).unwrap()
}

fn active_case(corpus: &Value) -> &Value {
    corpus["runtimeCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case.get("captured").is_some())
        .expect("shared corpus must exercise active runtime capture")
}

#[test]
fn runtime_corpus_roundtrips_exact_bytes_and_captures_artifacts() {
    let corpus = corpus();
    let fallback_facts = &active_case(&corpus)["facts"];
    let mut issuance_tags = BTreeSet::new();
    let mut idle = false;
    for case in corpus["runtimeCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let wire = case["wire"].as_str().unwrap();
        let runtime: AgentTraceRuntimeV1 =
            serde_json::from_str(wire).unwrap_or_else(|error| panic!("{id}: {error}"));
        assert_eq!(
            serde_json::to_value(&runtime).unwrap(),
            case["runtime"],
            "{id}: decode"
        );
        assert_eq!(
            serde_json::to_string(&runtime).unwrap(),
            wire,
            "{id}: exact wire"
        );
        if let Some(tag) = case["runtime"]["how"]["issuance"]["_tag"].as_str() {
            issuance_tags.insert(tag.to_owned());
        }
        let facts: ArtifactFacts =
            serde_json::from_value(case.get("facts").unwrap_or(fallback_facts).clone()).unwrap();
        if let Some(expected) = case.get("captured") {
            let captured = capture_artifact(runtime, facts).unwrap();
            assert_eq!(
                serde_json::to_value(&captured).unwrap(),
                *expected,
                "{id}: capture"
            );
            let strict: AgentTraceV2 = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(captured, strict, "{id}: strict artifact authority");
        } else {
            idle = true;
            assert_eq!(
                capture_artifact(runtime, facts),
                Err(CaptureError::MissingWhy),
                "{id}: idle"
            );
        }
    }
    assert!(idle, "shared corpus must exercise an idle seat");
    assert_eq!(
        issuance_tags,
        BTreeSet::from(["st-issued".to_owned(), "not-st-issued".to_owned()])
    );
}

#[test]
fn capture_moves_component_and_fact_string_allocations() {
    let corpus = corpus();
    let case = active_case(&corpus);
    let runtime: AgentTraceRuntimeV1 = serde_json::from_value(case["runtime"].clone()).unwrap();
    let facts: ArtifactFacts = serde_json::from_value(case["facts"].clone()).unwrap();
    let allocations = [
        runtime.r#type.as_str().as_ptr(),
        runtime.who.agent.as_str().as_ptr(),
        runtime.how.harness.tool.as_str().as_ptr(),
        runtime.how.model.route.as_str().as_ptr(),
        facts.id.as_str().as_ptr(),
        facts.at.as_str().as_ptr(),
        facts.artifact.as_str().as_ptr(),
    ];
    let captured = capture_artifact(runtime, facts).unwrap();
    assert_eq!(
        allocations,
        [
            captured.r#type.as_str().as_ptr(),
            captured.who.agent.as_str().as_ptr(),
            captured.how.harness.tool.as_str().as_ptr(),
            captured.how.model.route.as_str().as_ptr(),
            captured.id.as_str().as_ptr(),
            captured.at.as_str().as_ptr(),
            captured.artifact.as_str().as_ptr(),
        ]
    );
}

#[test]
fn runtime_rejects_invalid_and_artifact_only_fields() {
    let corpus = corpus();
    let valid = &active_case(&corpus)["runtime"];
    for (key, value) in [
        ("type", json!("agent-trace/v2")),
        ("id", json!("artifact-event")),
        ("at", json!("2026-10-12T00:00:00Z")),
        ("artifact", json!("git:abcdef")),
        ("why", Value::Null),
        ("why", json!({})),
        ("who", json!({"agent":"agent/seat"})),
        ("how", json!({})),
        ("where", json!({"unknown":"value"})),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(
            serde_json::from_value::<AgentTraceRuntimeV1>(invalid).is_err(),
            "accepted {key}"
        );
    }
    for key in ["type", "who", "how", "where"] {
        let mut invalid = valid.clone();
        invalid.as_object_mut().unwrap().remove(key);
        assert!(
            serde_json::from_value::<AgentTraceRuntimeV1>(invalid).is_err(),
            "accepted missing {key}"
        );
    }
    for issuance in [
        Value::Null,
        json!({"_tag":"unknown","launcher":"cli"}),
        json!({"_tag":"st-issued","step_run":"step-run/invalid/step"}),
        json!({"_tag":"st-issued","step_run":"step-run/0123456789abcdef0123456789abcdef/step","launcher":"cli"}),
        json!({"_tag":"not-st-issued","launcher":" "}),
        json!({"_tag":"not-st-issued","launcher":"cli","step_run":"step-run/0123456789abcdef0123456789abcdef/step"}),
    ] {
        let mut invalid = valid.clone();
        invalid["how"]["issuance"] = issuance;
        assert!(serde_json::from_value::<AgentTraceRuntimeV1>(invalid).is_err());
    }
}

#[test]
fn facts_reuse_strict_artifact_fields() {
    let corpus = corpus();
    let valid = &active_case(&corpus)["facts"];
    for (key, value) in [
        ("id", json!(" ")),
        ("at", json!("not-a-time")),
        ("artifact", json!("line\nbreak")),
        ("extra", json!(true)),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(
            serde_json::from_value::<ArtifactFacts>(invalid).is_err(),
            "accepted {key}"
        );
    }
    for key in ["id", "at", "artifact"] {
        let mut invalid = valid.clone();
        invalid.as_object_mut().unwrap().remove(key);
        assert!(
            serde_json::from_value::<ArtifactFacts>(invalid).is_err(),
            "accepted missing {key}"
        );
    }
}

#[test]
fn capture_and_runtime_encode_reject_purpose_emptied_after_decode() {
    let corpus = corpus();
    let case = active_case(&corpus);
    let mut runtime: AgentTraceRuntimeV1 = serde_json::from_value(case["runtime"].clone()).unwrap();
    let why = runtime.why.as_mut().unwrap();
    why.mission = None;
    why.step = None;
    assert!(serde_json::to_string(&runtime).is_err());
    let facts: ArtifactFacts = serde_json::from_value(case["facts"].clone()).unwrap();
    assert_eq!(
        capture_artifact(runtime, facts),
        Err(CaptureError::EmptyWhy)
    );
}
