//! Compiled test consumer of the shared generator's standalone runtime contract.
include!(concat!(env!("OUT_DIR"), "/types.rs"));

// This crate has no agent-trace dependency. Nested inclusion proves the
// distributed authority does not assume crate-root helper placement.
pub mod nested {
    pub mod runtime {
        include!(concat!(env!("OUT_DIR"), "/runtime.rs"));
    }
}

#[cfg(test)]
mod tests {
    use super::types;
    use serde::{de::DeserializeOwned, Serialize};
    use serde_json::{json, Value};

    fn roundtrip<T: DeserializeOwned + Serialize>(wire: &str) {
        let value: T = serde_json::from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), wire);
    }
    fn rejects<T: DeserializeOwned>(wire: &str) {
        assert!(serde_json::from_str::<T>(wire).is_err(), "accepted {wire}");
    }
    #[test]
    fn standalone_runtime_in_nested_module_supports_idle_and_both_issuance_tags() {
        use super::nested::runtime::{self, AgentTraceRuntimeV1};
        let idle = json!({
            "type": "agent-trace-runtime/v1",
            "who": {"agent": "agent/registry-consumer", "principal": "Johannes"},
            "how": {"harness": {"tool": "omp"}, "model": {"route": "openai/gpt"}},
            "where": {}
        });
        let decoded: AgentTraceRuntimeV1 = serde_json::from_value(idle.clone()).unwrap();
        assert!(decoded.why.is_none());
        assert_eq!(serde_json::to_value(decoded).unwrap(), idle);
        for issuance in [
            json!({"_tag": "st-issued", "step_run": "step-run/0123456789abcdef0123456789abcdef/step"}),
            json!({"_tag": "not-st-issued", "launcher": "cli"}),
        ] {
            let mut active = idle.clone();
            active["why"] = json!({"mission": {"name": "registry-consumer"}});
            active["how"]["issuance"] = issuance;
            let decoded: AgentTraceRuntimeV1 = serde_json::from_value(active.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), active);
        }
        // Constructors expose an ordinary public error suitable for `?`.
        let result: Result<
            runtime::AgentTraceRuntimeV1WhoAgent,
            runtime::__schema_registry_runtime::Error,
        > = "agent/registry-consumer".to_owned().try_into();
        assert!(result.is_ok());
        let mut invalid = idle;
        invalid["why"] = Value::Null;
        assert!(serde_json::from_value::<AgentTraceRuntimeV1>(invalid).is_err());
    }
    #[test]
    fn object_cardinality_is_enforced_on_decode_and_encode() {
        rejects::<types::Context>("{}");
        roundtrip::<types::Context>(r#"{"name":"context"}"#);
        let mut context: types::Context = serde_json::from_str(r#"{"name":"context"}"#).unwrap();
        context.r#name = None;
        assert!(serde_json::to_string(&context).is_err());
    }
    #[test]
    fn primitive_constraints_decode_and_constructors_reject_invalid_values() {
        for wire in ["-2", "0", "2", "4"] {
            roundtrip::<types::Integer>(wire);
        }
        for wire in ["-4", "1", "6", "1.5", "true", "null", "\"2\""] {
            rejects::<types::Integer>(wire);
        }
        assert!(types::Integer::try_from(serde_json::Number::from(1)).is_err());
        roundtrip::<types::IntegerLimit>("9007199254740992");
        rejects::<types::IntegerLimit>("9007199254740993");
        for wire in ["0.1", "0.3", "0.9"] {
            roundtrip::<types::Number>(wire);
        }
        for wire in ["0", "1", "0.15", "0.30000000000000004", "false", "1e400"] {
            rejects::<types::Number>(wire);
        }
        roundtrip::<types::Flag>("true");
        rejects::<types::Flag>("false");
        assert!(types::Flag::try_from(false).is_err());
        roundtrip::<types::NumericConst>("3");
        rejects::<types::NumericConst>("4");
        for wire in ["-0.5", "18446744073709551615"] {
            roundtrip::<types::Finite>(wire);
        }
        let large: types::Finite = serde_json::from_str("1e30").unwrap();
        assert_eq!(large.value().as_f64(), Some(1e30));
    }
    #[test]
    fn strings_keep_javascript_length_and_trim_semantics() {
        roundtrip::<types::Text>("\"😀\"");
        roundtrip::<types::Text>("\"ab\"");
        for wire in ["\"\"", "\"😀a\"", "\" a\"", "\"a \"", "\"\\ufeffa\""] {
            rejects::<types::Text>(wire);
        }
        assert!(types::Text::try_from("   ".to_owned()).is_err());
    }
    #[test]
    fn arrays_enforce_size_uniqueness_and_item_constraints() {
        roundtrip::<types::List>("[0,1,2]");
        for wire in [
            "[]",
            "[0,0]",
            "[1,1.0]",
            "[-1]",
            "[0,1,2,3]",
            "[null]",
            "[\"0\"]",
        ] {
            rejects::<types::List>(wire);
        }
        let zero = || serde_json::from_str::<types::ListItem>("0").unwrap();
        assert!(types::List::try_from(vec![zero(), zero()]).is_err());
    }
    #[test]
    fn discriminated_and_scalar_unions_enforce_const_and_branch_shape() {
        roundtrip::<types::Choice>(r#"{"kind":"ok","items":["one"]}"#);
        roundtrip::<types::Choice>(r#"{"kind":"error","message":"failure"}"#);
        for wire in [
            r#"{"kind":"other","items":[]}"#,
            r#"{"kind":"ok","message":"x"}"#,
            r#"{"kind":"ok","items":[""]}"#,
            r#"{"kind":"error","message":"x","extra":true}"#,
        ] {
            rejects::<types::Choice>(wire);
        }
        for wire in ["\"one\"", "\"two\""] {
            roundtrip::<types::ConstChoice>(wire);
        }
        rejects::<types::ConstChoice>("\"three\"");
        for wire in ["\"value\"", "null"] {
            roundtrip::<types::Nullable>(wire);
        }
        rejects::<types::Nullable>("false");
        rejects::<types::Nullable>("\"\"");
    }
    #[test]
    fn references_and_optional_fields_are_strict() {
        roundtrip::<types::Referenced>(r#"{"counts":[1,2]}"#);
        roundtrip::<types::Referenced>(r#"{"counts":[1],"maybe":"yes"}"#);
        for wire in [
            r#"{"counts":[0]}"#,
            r#"{"counts":[1],"maybe":null}"#,
            r#"{"counts":[1],"extra":1}"#,
        ] {
            rejects::<types::Referenced>(wire);
        }
    }
    #[test]
    fn real_producer_receipt_shapes_roundtrip() {
        let receipt = json!({
            "schema":"gate-slot.receipt/v1", "host":"dev3", "class":"gate", "pid":42,
            "cwd":"/work/tree", "cmd":["devenv","tasks","run","check:quick"],
            "startedAt":"2026-10-12T00:00:00Z", "endedAt":"2026-10-12T00:01:00Z",
            "exit":0, "headStart":"abcdef", "headEnd":"abcdef", "treeStart":"123456",
            "cleanStart":true, "cleanEnd":true, "exact":true, "expectShort":false,
            "outcome":"completed", "stAgent":"registry-test"
        });
        let wire = serde_json::to_string(&receipt).unwrap();
        roundtrip::<types::GateSlotReceipt>(&wire);
        let mut expired = receipt;
        expired["cleanStart"] = json!("unknown");
        expired["cleanEnd"] = json!("unknown");
        expired["exact"] = json!(false);
        expired["exit"] = json!(93);
        expired["expectShort"] = json!(true);
        expired["outcome"] = json!("not-short");
        expired["stAgent"] = Value::Null;
        roundtrip::<types::GateSlotReceipt>(&serde_json::to_string(&expired).unwrap());
        expired["cmd"] = json!([1]);
        rejects::<types::GateSlotReceipt>(&serde_json::to_string(&expired).unwrap());
    }
}
