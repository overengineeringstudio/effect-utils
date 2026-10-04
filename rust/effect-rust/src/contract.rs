//! Rust-owned contracts: schemars 1.x schemas carrying the effect-rust vocabulary.
//!
//! Rust authors annotate ordinary serde types; the schemars document is the
//! input to the TypeScript importer (`Compiler.importRustSchema`), which emits
//! the Effect Schema codecs. Admission is strict there: an integer schema without
//! a portable width (for example a plain `u64`) fails generation.
//!
//! ```ignore
//! #[effect_rust::contract]
//! #[derive(serde::Serialize, serde::Deserialize, effect_rust::contract::JsonSchema)]
//! #[serde(rename_all = "camelCase")]
//! pub struct Order {
//!     #[wire(u64)]
//!     pub id: u64,
//!     #[wire(timestamp_millis)]
//!     pub placed_at: chrono::DateTime<chrono::Utc>,
//!     pub note: effect_rust::Patch<String>,
//!     pub host: HostName,
//! }
//!
//! #[effect_rust::contract(pattern = "^[a-z][a-z0-9-]*$", min_length = 1, max_length = 63)]
//! pub struct HostName(String);
//! ```
//!
//! Core crates keep the contract optional by putting the macro and its derives
//! in one `cfg_attr`, which expands them in order:
//! `#[cfg_attr(feature = "contract", effect_rust::contract, derive(...))]`.

use crate::{wire::TimestampMillis, Patch};
use schemars::{json_schema, Schema, SchemaGenerator};
use std::borrow::Cow;

pub use schemars::{self, JsonSchema};

/// JSON Schema vocabulary URI understood by the importer.
pub const VOCABULARY: &str = "https://effect-rust.dev/schema/v1";

/// Schema of a canonical base-10 `u64` string; used by `#[wire(u64)]`.
pub enum U64 {}
/// Schema of a canonical base-10 `i64` string; used by `#[wire(i64)]`.
pub enum I64 {}
/// Schema of an explicit finite IEEE binary32 numeric field.
pub enum F32 {}

impl JsonSchema for F32 {
    fn inline_schema() -> bool { true }
    fn schema_name() -> Cow<'static, str> { "F32".into() }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "number", "format": "float", "x-effect-rust-width": "f32", "x-effect-rust-nonfinite": "reject" })
    }
}

impl JsonSchema for U64 {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "U64".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)$",
            "x-effect-rust-width": "u64",
            "x-effect-rust-format": "u64-decimal",
        })
    }
}

impl JsonSchema for I64 {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "I64".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "pattern": "^(0|-?[1-9][0-9]*)$",
            "x-effect-rust-width": "i64",
            "x-effect-rust-format": "i64-decimal",
        })
    }
}

impl JsonSchema for TimestampMillis {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "TimestampMillis".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "format": "date-time", "x-effect-rust-format": "date-time-millis" })
    }
}

/// A Patch property: omitted (`Absent`), `null`, or a value. Inlined so the
/// marker sits on the property schema, where the importer expects it.
impl<T: JsonSchema> JsonSchema for Patch<T> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        format!("Patch_{}", T::schema_name()).into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "anyOf": [{ "type": "null" }, generator.subschema_for::<T>()], "x-effect-rust-patch": true })
    }
}

/// Schema of `T` as a required property, even when `T` is an `Option`:
/// `#[effect_rust::contract]` makes `Option` fields required-and-nullable.
pub struct Required<T: ?Sized>(std::marker::PhantomData<T>);

impl<T: JsonSchema + ?Sized> JsonSchema for Required<T> {
    fn inline_schema() -> bool {
        T::inline_schema()
    }
    fn schema_name() -> Cow<'static, str> {
        T::schema_name()
    }
    fn schema_id() -> Cow<'static, str> {
        T::schema_id()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        T::json_schema(generator)
    }
}

/// Excess-property policies; `#[effect_rust::contract(excess = "...")]` applies them.
#[doc(hidden)]
pub mod excess {
    use schemars::Schema;
    use serde_json::Value;

    /// Unknown keys are rejected (serde `deny_unknown_fields`).
    pub fn error(schema: &mut Schema) {
        apply(schema, "error");
    }

    /// Unknown keys are accepted and dropped. The schema stays closed: the
    /// policy is carried by the vocabulary keyword, not an open object.
    pub fn ignore(schema: &mut Schema) {
        apply(schema, "ignore");
    }

    fn apply(schema: &mut Schema, policy: &str) {
        let Some(object) = schema.as_object_mut() else {
            return;
        };
        for union in ["oneOf", "anyOf"] {
            if let Some(Value::Array(branches)) = object.get_mut(union) {
                // Tagged-union variants are inline objects; each carries the policy.
                for branch in branches.iter_mut().filter_map(Value::as_object_mut) {
                    if branch.get("type").and_then(Value::as_str) == Some("object") {
                        close(branch, policy);
                    }
                }
            }
        }
        if object.get("type").and_then(Value::as_str) == Some("object") {
            close(object, policy);
        }
    }

    fn close(object: &mut serde_json::Map<String, Value>, policy: &str) {
        object.insert("additionalProperties".into(), Value::Bool(false));
        object.insert("x-effect-rust-excess".into(), Value::String(policy.into()));
    }
}

/// Per-export schema record read by the packager: the schemas of every JSON
/// argument and of the JSON result, plus all reachable named definitions.
///
/// `#[effect_rust::export]` builds one for exports with serde domain types.
pub struct ExportSchema {
    generator: SchemaGenerator,
    args: serde_json::Map<String, serde_json::Value>,
    returns: Option<serde_json::Value>,
}

impl Default for ExportSchema {
    fn default() -> Self {
        Self {
            generator: schemars::generate::SchemaSettings::draft2020_12().into_generator(),
            args: serde_json::Map::new(),
            returns: None,
        }
    }
}

impl ExportSchema {
    #[must_use]
    pub fn arg<T: JsonSchema + ?Sized>(mut self, name: &str) -> Self {
        let schema = self.generator.subschema_for::<T>().to_value();
        self.args.insert(name.to_owned(), schema);
        self
    }

    #[must_use]
    pub fn returns<T: JsonSchema + ?Sized>(mut self) -> Self {
        self.returns = Some(self.generator.subschema_for::<T>().to_value());
        self
    }

    /// Draft 2020-12 document declaring the effect-rust vocabulary.
    #[must_use]
    pub fn into_json(mut self) -> serde_json::Value {
        let definitions = self.generator.take_definitions(true);
        serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$vocabulary": {
                "https://json-schema.org/draft/2020-12/vocab/core": true,
                "https://json-schema.org/draft/2020-12/vocab/applicator": true,
                "https://json-schema.org/draft/2020-12/vocab/validation": true,
                "https://json-schema.org/draft/2020-12/vocab/meta-data": true,
                "https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
                (VOCABULARY): true,
            },
            "$defs": definitions,
            "args": self.args,
            "returns": self.returns,
        })
    }
}

#[doc(hidden)]
pub mod __private {
    pub use regex::Regex;
    pub use std::sync::LazyLock;
}
