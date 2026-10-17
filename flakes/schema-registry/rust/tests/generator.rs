use schema_registry_rust::{generate, parse_schema, Options};
use serde_json::{json, Value};

fn lower(schema: &Value) -> Result<String, schema_registry_rust::Error> {
    generate(schema, "Example", &Options::default())
}
#[test]
fn unsupported_or_malformed_semantics_fail_before_emission() {
    for schema in [
        json!(true),
        json!({"type":"object", "properties":{}, "additionalProperties":true}),
        json!({"type":"object", "properties":{}, "additionalProperties":false, "required":["missing"]}),
        json!({"type":"string", "format":"date-time"}),
        json!({"type":"string", "minLength":-1}),
        json!({"type":"string", "pattern":"(?=x)"}),
        json!({"type":"string", "pattern":r"\w+"}),
        json!({"type":"string", "pattern":"."}),
        json!({"type":"string", "pattern":"(?i)x"}),
        json!({"type":"string", "pattern":r"\Afoo"}),
        json!({"type":"string", "pattern":"[a&&b]"}),
        json!({"type":"string", "enum":[1]}),
        json!({"type":"boolean", "const":"true"}),
        json!({"type":"number", "multipleOf":0}),
        json!({"type":"integer", "const":1.5}),
        json!({"const":{"not":"scalar"}}),
        json!({"type":"array"}),
        json!({"type":"array", "items":[{"type":"string"}]}),
        json!({"type":"array", "items":{"type":"string"}, "contains":{"const":"x"}}),
        json!({"type":"number", "allOf":[{"allOf":[{"minLength":1}]}]}),
        json!({"type":"string", "allOf":[{"type":"integer"}]}),
        json!({"type":["string","null"]}),
        json!({"$ref":"https://example.com/schema"}),
        json!({"$ref":"#/$defs/missing"}),
        json!({"$ref":"#/$defs/recursive", "$defs":{"recursive":{"$ref":"#/$defs/recursive"}}}),
        json!({"$dynamicRef":"#root", "type":"string"}),
        json!({"type":"object", "properties":{"a-b":{"type":"string"}}, "additionalProperties":false}),
        json!({"type":"object", "properties":{"__":{"type":"string"}}, "additionalProperties":false}),
        json!({"type":"object", "properties":{"a_b":{"type":"string"},"a__b":{"type":"string"}}, "additionalProperties":false}),
    ] {
        assert!(lower(&schema).is_err(), "accepted {schema}");
    }
}
#[test]
fn union_validity_requires_disjoint_kinds_or_required_distinct_constants() {
    for key in ["anyOf", "oneOf"] {
        let object = |tag: &str, required: bool| json!({"type":"object","properties":{"kind":{"const":tag}},"required":if required { vec!["kind"] } else { Vec::new() },"additionalProperties":false});
        let union = |branches: Vec<Value>| {
            let mut schema = json!({});
            schema[key] = json!(branches);
            schema
        };
        assert!(lower(&union(vec![object("one", true), object("two", true)])).is_ok());
        assert!(lower(&union(vec![object("one", true), object("one", true)])).is_err());
        assert!(lower(&union(vec![object("one", false), object("two", false)])).is_err());
        assert!(lower(&union(vec![
            json!({"type":"boolean"}),
            json!({"const":"unknown"})
        ]))
        .is_ok());
        assert!(lower(&union(vec![
            json!({"type":"integer"}),
            json!({"type":"number"})
        ]))
        .is_err());
        assert!(lower(&union(vec![json!({"const":1}), json!({"const":1.0})])).is_err());
        assert!(lower(&union(vec![
            json!({"type":"string"}),
            json!({"type":"string"})
        ]))
        .is_err());
        assert!(lower(&union(Vec::new())).is_err());
    }
}
#[test]
fn numeric_contract_is_exact_across_integer_float_and_exponent_representations() {
    use schema_registry_rust::numbers::{
        compare_number, is_integer, is_multiple_of, numbers_equal,
    };
    use std::cmp::Ordering;
    let number = |wire: &str| serde_json::from_str::<serde_json::Number>(wire).unwrap();
    assert!(numbers_equal(&number("1"), &number("1.0")));
    assert!(!numbers_equal(
        &number("9007199254740992"),
        &number("9007199254740993")
    ));
    assert_eq!(
        compare_number(&number("18446744073709551615"), "18446744073709551614"),
        Ordering::Greater
    );
    assert_eq!(compare_number(&number("-2"), "-1.0"), Ordering::Less);
    assert_eq!(compare_number(&number("0"), "-0.0"), Ordering::Equal);
    assert!(is_integer(&number("1e30")));
    assert!(!is_integer(&number("1e-30")));
    assert!(is_multiple_of(&number("0.3"), "0.1"));
    assert!(is_multiple_of(&number("-0.3"), "0.1"));
    assert!(!is_multiple_of(&number("0.30000000000000004"), "0.1"));
}
#[test]
fn local_pointer_refs_and_constraint_siblings_lower_without_agent_trace_runtime() {
    let schema = json!({"$defs":{"positive":{"type":"integer","minimum":1}},"$ref":"#/$defs/positive","allOf":[{"maximum":10}]});
    let generated = generate(
        &schema,
        "Count",
        &Options {
            runtime_module: "crate::support",
            ..Options::default()
        },
    )
    .unwrap();
    assert!(generated.contains("crate::support::Error"));
    assert!(generated.contains(r#"compare_number(value, "1").is_lt()"#));
    assert!(generated.contains(r#"compare_number(value, "10").is_gt()"#));
    let schema = json!({"const":"crate::literal"});
    let generated = generate(
        &schema,
        "Literal",
        &Options {
            runtime_module: "crate::support",
            ..Options::default()
        },
    )
    .unwrap();
    assert!(generated.contains(r#"value != "crate::literal""#));
    assert!(!generated.contains("crate::support::literal"));
}
#[test]
fn existing_object_string_emission_is_byte_stable() {
    let schema = parse_schema(r#"{"type":"object","properties":{"id":{"type":"string","minLength":1,"enum":["old"]}},"additionalProperties":false,"minProperties":1}"#).unwrap();
    let output = generate(
        &schema,
        "Legacy",
        &Options {
            validate_object_serialization: false,
            ..Options::default()
        },
    )
    .unwrap();
    // Snapshot of the pre-extraction build.rs emitter, including order and spacing.
    let expected = r#"#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct LegacyId(String);
impl LegacyId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("LegacyId: minLength".into())); }
if !["old"].contains(&value) { return Err(crate::Error::Invalid("LegacyId: enum".into())); }
Ok(()) } }
impl TryFrom<String> for LegacyId { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for LegacyId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "RawLegacy")]
#[serde(deny_unknown_fields)]
pub struct Legacy {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#id: Option<LegacyId>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLegacy {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#id: Option<LegacyId>,
}
impl TryFrom<RawLegacy> for Legacy { type Error = crate::Error; fn try_from(raw: RawLegacy) -> Result<Self, Self::Error> {
let count = [raw.r#id.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("Legacy requires context".into())); }
Ok(Self {
r#id: raw.r#id,
}) } }
"#;
    assert_eq!(output, expected);
}
