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
    struct Vector {
        contract: String,
        name: String,
        input: serde_json::Value,
        accept: bool,
        canonical: Option<serde_json::Value>,
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
            let input = vector.input.to_string();
            let result = match vector.contract.as_str() {
                "Discount" => roundtrip::<Discount>(&input),
                "Order" => roundtrip::<Order>(&input),
                "Quote" => roundtrip::<Quote>(&input),
                other => panic!("unknown vector contract {other}"),
            };
            let label = format!("{}/{}", vector.contract, vector.name);
            match (vector.accept, result) {
                (true, Ok(encoded)) => {
                    let canonical = encode_json(
                        vector.canonical.as_ref().unwrap_or(&vector.input),
                        &["kind"],
                    )
                    .unwrap();
                    assert_eq!(encoded, canonical, "{label}");
                }
                (false, Err(_)) => {}
                (accept, result) => panic!("{label}: expected accept={accept}, got {result:?}"),
            }
        }
    }

    #[test]
    fn streaming_path_reports_nested_payload_paths() {
        let fast = decode_json::<Quote>(r#"{"kind":"priced","receipt":{"orderId":"1","sku":"bad","totalCents":"1","placedAt":"2026-10-02T00:00:00.000Z"},"note":null}"#).unwrap_err();
        assert_eq!(fast.path, "$.receipt.sku");
        // Tag-last input is valid but buffered; the payload error keeps the union root.
        let buffered = decode_json::<Quote>(r#"{"receipt":{"orderId":"1","sku":"bad","totalCents":"1","placedAt":"2026-10-02T00:00:00.000Z"},"note":null,"kind":"priced"}"#).unwrap_err();
        assert!(buffered.message.contains("string must match"), "{buffered}");
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
}
