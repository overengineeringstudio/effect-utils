use agent_trace::{
    decode, decode_commit, decode_legacy_footer, decode_legacy_trailer, encode, summary, types,
    upgrade_legacy, utf16_len, Audience, Medium, View,
};
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn fixture_path(case: &Value, key: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures")
        .join(case[key].as_str().unwrap())
}

// The TS emitter owns canonical JSON layout through formatArtifact/oxfmt.
// Reuse that exact formatter on Rust-serialized decoded types, never on the expected fixture.
fn assert_decoded_view_bytes(case: &Value, decoded: &View) {
    let path = fixture_path(case, "viewPath");
    let mut formatter = Command::new("oxfmt")
        .arg("--stdin-filepath")
        .arg(&path)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Shared canonical fixture formatter oxfmt must be on PATH");
    {
        let mut stdin = formatter.stdin.take().unwrap();
        serde_json::to_writer(&mut stdin, decoded).unwrap();
        stdin.write_all(b"\n").unwrap();
    }
    let output = formatter.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}: canonical formatter failed: {}",
        case["id"],
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        std::fs::read(path).unwrap(),
        "{}: decoded view bytes (including key order, indentation and final newline)",
        case["id"]
    );
}

fn corpus() -> Value {
    serde_json::from_str(include_str!("../../fixtures/codec-corpus.json")).unwrap()
}
fn audience(case: &Value) -> Audience {
    serde_json::from_value(case["audience"].clone()).unwrap()
}
fn medium(case: &Value) -> Medium {
    match case["binding"].as_str().unwrap() {
        "trailer/v2" | "trailer/v1" => Medium::Trailer,
        "footer/v4" | "footer/v3" => Medium::Footer,
        other => panic!("Unknown binding {other}"),
    }
}
#[test]
fn committed_json_text_pairs_match_the_shared_index() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/codec-pairs");
    for case in corpus()["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let wire = std::fs::read_to_string(directory.join(format!("{id}.wire.txt"))).unwrap();
        let view = std::fs::read(directory.join(format!("{id}.view.json"))).unwrap();
        assert_eq!(wire, case["wire"].as_str().unwrap(), "{id}: wire pair");
        assert_eq!(
            serde_json::from_slice::<Value>(&view).unwrap(),
            case["view"],
            "{id}: view pair index"
        );
    }
}
#[test]
fn shared_current_corpus_is_byte_identical_in_both_directions() {
    for case in corpus()["cases"].as_array().unwrap() {
        if case["kind"] != "current" {
            continue;
        }
        let id = case["id"].as_str().unwrap();
        let wire = case["wire"].as_str().unwrap();
        let view = View::from_value(case["view"].clone(), audience(case), medium(case))
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(encode(&view).unwrap(), wire, "{id}: encode");
        let decoded =
            decode(wire, audience(case), medium(case)).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(decoded.value().unwrap(), case["view"], "{id}: decode");
        assert_decoded_view_bytes(case, &decoded);
        assert_eq!(encode(&decoded).unwrap(), wire, "{id}: reencode");
    }
}
#[test]
fn shared_legacy_corpus_upgrades_without_fabrication() {
    for case in corpus()["cases"].as_array().unwrap() {
        if case["kind"] != "legacy" {
            continue;
        }
        let wire = case["wire"].as_str().unwrap();
        let legacy = if medium(case) == Medium::Trailer {
            decode_legacy_trailer(wire)
        } else {
            decode_legacy_footer(wire).unwrap()
        };
        assert_eq!(
            serde_json::to_value(&legacy.fields).unwrap(),
            case["observations"],
            "{}: tags",
            case["id"]
        );
        let upgraded = upgrade_legacy(&legacy, audience(case)).unwrap();
        assert_eq!(upgraded.value().unwrap(), case["view"], "{}", case["id"]);
        assert_decoded_view_bytes(case, &upgraded);
        if let Some(expected) = case.get("summary") {
            assert_eq!(
                summary(&upgraded.value().unwrap()),
                expected.as_str().unwrap(),
                "{}: summary",
                case["id"]
            );
        }
        assert!(
            encode(&upgraded).is_err(),
            "sparse legacy data cannot be a current writer"
        );
    }
}
#[test]
fn shared_invalid_corpus_is_rejected() {
    for case in corpus()["invalid"].as_array().unwrap() {
        assert!(
            decode(case["wire"].as_str().unwrap(), audience(case), medium(case)).is_err(),
            "{}",
            case["id"]
        );
    }
}
#[test]
fn routes_use_utf16_units_and_exact_authority_grammar() {
    let at_boundary = format!("a/{}😀", "b".repeat(60));
    assert_eq!(utf16_len(&at_boundary), 64);
    assert_eq!(utf16_len(&format!("{at_boundary}b")), 65);
    for case in corpus()["modelRoutes"].as_array().unwrap() {
        let route = case["value"].as_str().unwrap();
        assert_eq!(
            utf16_len(route),
            usize::try_from(case["utf16Length"].as_u64().unwrap()).unwrap()
        );
        assert_eq!(
            types::PrivateTrailerV2HowModelRoute::try_from(route.to_owned()).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
    }
}
#[test]
fn human_summary_is_not_authoritative_and_current_errors_do_not_fallback() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "current" && c["binding"] == "trailer/v2")
        .unwrap();
    let machine = case["wire"].as_str().unwrap().split_once('\n').unwrap().1;
    for human in [
        "Agent: preview wording",
        "On-Behalf-Of: tampered",
        "arbitrary",
    ] {
        assert_eq!(
            decode_commit(&format!("{human}\n{machine}"), audience(case))
                .unwrap()
                .unwrap()
                .value()
                .unwrap(),
            case["view"]
        );
    }
    assert!(decode_commit(
        "Agent-Trace: malformed\nagent-identity: agent/test",
        Audience::Private
    )
    .is_err());
}
#[test]
fn nested_deserialization_rejects_unknown_fields_and_null_optionals() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "current" && c["binding"] == "trailer/v2")
        .unwrap();
    let mut value = case["view"].clone();
    value["how"]["model"]["extra"] = Value::Bool(true);
    assert!(View::from_value(value, audience(case), medium(case)).is_err());
    let mut value = case["view"].clone();
    value["who"]["persona"] = Value::Null;
    assert!(View::from_value(value, audience(case), medium(case)).is_err());
}
#[test]
fn internal_runtime_facts_are_private_and_strict_in_both_media() {
    for case in corpus()["cases"].as_array().unwrap() {
        if case["kind"] != "current" {
            continue;
        }
        for key in ["runtime_profile", "skills_manifest", "invocation_id"] {
            let mut value = case["view"].clone();
            value["how"][key] = Value::String("runtime-fact".into());
            let view = View::from_value(value, audience(case), medium(case));
            if audience(case) == Audience::Public {
                assert!(view.is_err(), "{}: public {key}", case["id"]);
            } else {
                let view = view.unwrap();
                let decoded =
                    decode(&encode(&view).unwrap(), audience(case), medium(case)).unwrap();
                assert_eq!(decoded.value().unwrap()["how"][key], "runtime-fact");
                let mut value = case["view"].clone();
                value["how"][key] = Value::Null;
                assert!(View::from_value(value, audience(case), medium(case)).is_err());
            }
        }
    }
}
#[test]
fn issuance_variants_are_private_and_roundtrip_in_both_media() {
    for case in corpus()["cases"].as_array().unwrap() {
        if case["kind"] != "current" {
            continue;
        }
        for issuance in [
            serde_json::json!({
                "_tag": "st-issued",
                "step_run": "step-run/fedcba9876543210fedcba9876543210/compare"
            }),
            serde_json::json!({ "_tag": "not-st-issued", "launcher": "hypermerge" }),
            serde_json::json!({ "_tag": "not-st-issued", "launcher": "molty" }),
        ] {
            let mut value = case["view"].clone();
            value["how"]["issuance"] = issuance.clone();
            let view = View::from_value(value, audience(case), medium(case));
            if audience(case) == Audience::Public {
                assert!(view.is_err(), "{}: public issuance", case["id"]);
            } else {
                let view = view.unwrap();
                let decoded =
                    decode(&encode(&view).unwrap(), audience(case), medium(case)).unwrap();
                assert_eq!(decoded.value().unwrap()["how"]["issuance"], issuance);
            }
        }
    }
}
#[test]
fn text_constraints_match_ecmascript_trim_and_single_line_semantics() {
    assert!(types::PrivateTrailerV2WhoPrincipal::try_from("\u{feff}human".to_owned()).is_err());
    assert!(types::PrivateTrailerV2WhoPrincipal::try_from("human\u{feff}".to_owned()).is_err());
    assert!(types::PrivateTrailerV2WhoPrincipal::try_from("\u{0085}human".to_owned()).is_ok());
    assert!(types::PrivateTrailerV2WhoPrincipal::try_from("human\nother".to_owned()).is_err());
}
#[test]
fn semantic_timestamp_uses_ascii_digits_like_ecmascript() {
    assert!(types::AgentTraceV2At::try_from("2026-10-10T12:34:56Z".to_owned()).is_ok());
    assert!(types::AgentTraceV2At::try_from("٢٠٢٦-10-10T12:34:56Z".to_owned()).is_err());
}
#[test]
fn shared_untraced_commits_have_no_binding_view() {
    for case in corpus()["untraced"].as_array().unwrap() {
        for audience in [Audience::Public, Audience::Private] {
            assert!(
                decode_commit(case["wire"].as_str().unwrap(), audience)
                    .unwrap()
                    .is_none(),
                "{}",
                case["id"]
            );
        }
    }
}
