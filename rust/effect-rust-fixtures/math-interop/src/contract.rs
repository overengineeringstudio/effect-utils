//! Rust-owned contract fixture: serde/schemars types crossing the export edge.
use chrono::{DateTime, Utc};
use effect_rust::contract::JsonSchema;
use effect_rust::Patch;
use serde::{Deserialize, Serialize};

/// Shared contract vectors embedded in the actual library artifact.
pub const CONTRACT_VECTORS_JSON: &str = include_str!("../vectors.json");

/// Stock-keeping unit: three capitals, a dash and four digits.
#[effect_rust::contract(pattern = "^[A-Z]{3}-[0-9]{4}$")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sku(String);

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    #[wire(u64)]
    pub id: u64,
    pub sku: Sku,
    pub quantity: u32,
    #[wire(u64)]
    pub unit_price_cents: u64,
    #[wire(timestamp_millis)]
    pub placed_at: DateTime<Utc>,
    /// Omitted keeps the stored note, `null` clears it, a string replaces it.
    pub note: Patch<String>,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Discount {
    None,
    Percent {
        percent: u8,
    },
    Fixed {
        #[wire(u64)]
        amount_cents: u64,
    },
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    #[wire(u64)]
    pub order_id: u64,
    pub sku: Sku,
    #[wire(u64)]
    pub total_cents: u64,
    #[wire(timestamp_millis)]
    pub placed_at: DateTime<Utc>,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Quote {
    Priced {
        receipt: Receipt,
        note: Option<String>,
    },
    Free {
        #[wire(u64)]
        order_id: u64,
    },
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FloatSample {
    #[wire(f32)]
    pub value: f32,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NullableFloatSample {
    #[wire(f32)]
    pub value: Option<f32>,
}

/// A score alias keeps the binary32 wire policy on its containing field.
pub type RecordingScore = f32;

/// Required nullable score, annotated explicitly at the contract edge.
pub type AverageRecordingScore = Option<RecordingScore>;

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NestedMatchArtistInput {
    pub name: String,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NestedMatchRecordingInput {
    pub title: String,
    pub duration_ms: u32,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NestedMatchInput {
    pub artist: NestedMatchArtistInput,
    pub recordings: Vec<NestedMatchRecordingInput>,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NestedMatchArtist {
    pub id: String,
    pub name: String,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NestedMatchRecording {
    pub id: String,
    pub title: String,
    pub duration_ms: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_string"
    )]
    #[schemars(with = "String")]
    pub isrc: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_string"
    )]
    #[schemars(with = "String")]
    pub release: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_string"
    )]
    #[schemars(with = "String")]
    pub album: Option<String>,
}

/// Absence is allowed; a present optional string is never a JSON null.
fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NestedMatchRecordingMatch {
    pub recording: NestedMatchRecording,
    #[wire(f32)]
    pub matching_score: f32,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NestedMatchResult {
    pub artist: NestedMatchArtist,
    #[wire(f32)]
    pub artist_match_score: f32,
    // The alias owns the explicit required/nullable binary32 policy; no serde default.
    #[serde(with = "effect_rust::wire::f32::nullable")]
    #[schemars(with = "effect_rust::contract::Required<Option<effect_rust::contract::F32>>")]
    pub average_recording_score: AverageRecordingScore,
    pub recordings: Vec<NestedMatchRecordingMatch>,
}

#[effect_rust::contract]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WideSample {
    #[wire(u64)]
    pub unsigned: u64,
    #[wire(i64)]
    pub signed: i64,
}

/// Native-object numeric regression: full-width u32/i32 plus a safe bounded u64.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(crate = "effect_rust::contract::schemars")]
pub struct NumericOperands {
    pub unsigned: u32,
    pub signed: i32,
    #[serde(deserialize_with = "safe_integer")]
    #[schemars(range(min = 0, max = 9_007_199_254_740_991_u64))]
    pub bounded: u64,
}

fn safe_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom("expected a safe unsigned integer"));
    }
    Ok(value)
}

/// Prices an order; `note: null` clears the note, `Absent` keeps none.
#[must_use]
pub fn quote(order: Order, discount: &Discount) -> Option<Quote> {
    let gross = order
        .unit_price_cents
        .checked_mul(u64::from(order.quantity))?;
    let total = match discount {
        Discount::None => gross,
        Discount::Percent { percent } => {
            gross.checked_mul(u64::from(100_u8.saturating_sub(*percent)))? / 100
        }
        Discount::Fixed { amount_cents } => gross.saturating_sub(*amount_cents),
    };
    if total == 0 {
        return Some(Quote::Free { order_id: order.id });
    }
    let note = match order.note {
        Patch::Absent | Patch::Null => None,
        Patch::Value(note) => Some(note),
    };
    Some(Quote::Priced {
        receipt: Receipt {
            order_id: order.id,
            sku: order.sku,
            total_cents: total,
            placed_at: order.placed_at,
        },
        note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use effect_rust::wire::{decode_json, encode_json};

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        contract: String,
        name: String,
        input: serde_json::Value,
        accept: bool,
        canonical: Option<serde_json::Value>,
        input_json: Option<String>,
        canonical_json: Option<String>,
    }

    fn roundtrip<T: serde::de::DeserializeOwned + Serialize>(
        input: &str,
    ) -> Result<String, effect_rust::ValidationError> {
        encode_json(&decode_json::<T>(input)?, &["kind"])
    }

    /// The same vectors run against the generated Effect codecs (service-smoke.ts).
    #[test]
    fn shared_vectors_decode_and_encode_canonically() {
        let vectors: Vec<Vector> = serde_json::from_str(super::CONTRACT_VECTORS_JSON).unwrap();
        for vector in vectors {
            let input = vector
                .input_json
                .unwrap_or_else(|| vector.input.to_string());
            let result = match vector.contract.as_str() {
                "Discount" => roundtrip::<Discount>(&input),
                "Order" => roundtrip::<Order>(&input),
                "Quote" => roundtrip::<Quote>(&input),
                "FloatSample" => roundtrip::<FloatSample>(&input),
                "NullableFloatSample" => roundtrip::<NullableFloatSample>(&input),
                "WideSample" => roundtrip::<WideSample>(&input),
                "NestedMatchInput" => roundtrip::<NestedMatchInput>(&input),
                "NestedMatchResult" => roundtrip::<NestedMatchResult>(&input),
                other => panic!("unknown vector contract {other}"),
            };
            let label = format!("{}/{}", vector.contract, vector.name);
            match (vector.accept, result) {
                (true, Ok(encoded)) => {
                    let canonical = vector.canonical_json.unwrap_or_else(|| {
                        encode_json(
                            vector.canonical.as_ref().unwrap_or(&vector.input),
                            &["kind"],
                        )
                        .unwrap()
                    });
                    assert_eq!(encoded, canonical, "{label}");
                }
                (false, Err(_)) => {}
                (accept, result) => panic!("{label}: expected accept={accept}, got {result:?}"),
            }
        }
    }

    #[test]
    fn nullable_binary32_is_required_finite_and_schema_marked() {
        assert_eq!(
            decode_json::<NullableFloatSample>(r#"{"value":null}"#)
                .unwrap()
                .value,
            None
        );
        assert_eq!(
            decode_json::<NullableFloatSample>(r#"{"value":0.1}"#)
                .unwrap()
                .value,
            Some(0.1_f32)
        );
        assert!(decode_json::<NullableFloatSample>("{}").is_err());
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(encode_json(&NullableFloatSample { value: Some(value) }, &[]).is_err());
        }
        let schema = effect_rust::contract::schemars::schema_for!(NullableFloatSample).to_value();
        assert_eq!(schema["required"], serde_json::json!(["value"]));
        assert_eq!(
            schema["properties"]["value"]["type"],
            serde_json::json!(["number", "null"])
        );
        assert_eq!(schema["properties"]["value"]["x-effect-rust-width"], "f32");
        assert_eq!(
            schema["properties"]["value"]["x-effect-rust-nonfinite"],
            "reject"
        );
    }

    #[test]
    fn streaming_path_reports_nested_payload_paths() {
        let fast = decode_json::<Quote>(r#"{"kind":"priced","receipt":{"orderId":"1","sku":"bad","totalCents":"1","placedAt":"2026-10-02T00:00:00.000Z"},"note":null}"#).unwrap_err();
        assert_eq!(fast.path, "$.receipt.sku");
    }

    #[test]
    fn strict_contract_rejections() {
        for (input, path) in [
            (r#"{"kind":"percent","percent":5,"extra":true}"#, "$.extra"),
            (r#"{"kind":"percent","percent":256}"#, "$.percent"),
            (r#"{"kind":"unknown"}"#, "$.kind"),
            (r#"{"kind":"fixed","amountCents":7}"#, "$.amountCents"),
            (r#"{"kind":"fixed","amountCents":"07"}"#, "$.amountCents"),
            (r#"{"kind":"none","kind":"none"}"#, "$"),
        ] {
            let error = decode_json::<Discount>(input).expect_err(input);
            assert_eq!(error.path, path, "{input}: {error}");
        }
    }

    #[test]
    fn patch_and_timestamp_fields_keep_wire_semantics() {
        let input = r#"{"id":"9007199254740993","sku":"ABC-1234","quantity":3,"unitPriceCents":"250","placedAt":"2026-10-02T12:00:00.5+02:00"}"#;
        let order: Order = decode_json(input).unwrap();
        assert_eq!(order.note, Patch::Absent);
        assert_eq!(
            encode_json(&order, &[]).unwrap(),
            r#"{"id":"9007199254740993","placedAt":"2026-10-02T10:00:00.500Z","quantity":3,"sku":"ABC-1234","unitPriceCents":"250"}"#
        );
        let cleared: Order = decode_json(&input.replace('}', r#","note":null}"#)).unwrap();
        assert_eq!(cleared.note, Patch::Null);
    }

    #[test]
    fn nested_match_alias_preserves_binary32_and_optional_omission() {
        let schema = effect_rust::contract::schemars::schema_for!(NestedMatchResult).to_value();
        let score = &schema["properties"]["averageRecordingScore"];
        assert_eq!(score["x-effect-rust-width"], "f32");
        assert_eq!(score["x-effect-rust-nonfinite"], "reject");
        assert_eq!(score["type"], serde_json::json!(["number", "null"]));
        let input = r#"{"artist":{"name":"Fixture Artist"},"recordings":[{"title":"First","durationMs":180000},{"title":"Second","durationMs":240000},{"title":"Ignored","durationMs":1}]}"#;
        let mut matched = crate::nested_match(decode_json(input).unwrap()).unwrap();
        assert_eq!(matched.recordings.len(), 2);
        assert_eq!(matched.average_recording_score, Some(0.75));
        let encoded = encode_json(&matched, &[]).unwrap();
        let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert!(json["recordings"][1]["recording"].get("isrc").is_none());
        assert!(json["recordings"][0]["recording"].get("release").is_none());
        assert!(json["recordings"][0]["recording"].get("album").is_none());
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            matched.average_recording_score = Some(value);
            assert!(encode_json(&matched, &[]).is_err());
            matched.average_recording_score = None;
            matched.artist_match_score = value;
            assert!(encode_json(&matched, &[]).is_err());
            matched.artist_match_score = 1.0;
            matched.recordings[0].matching_score = value;
            assert!(encode_json(&matched, &[]).is_err());
            matched.recordings[0].matching_score = 1.0;
        }
    }
}
