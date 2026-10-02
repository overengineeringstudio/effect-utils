// Generated from the compiler's JSON Schema; do not edit.
fn schema(name: &str, generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let document: serde_json::Value = serde_json::from_str(r###"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$vocabulary": {
    "https://effect-rust.dev/schema/v1": true
  },
  "title": "ContentDescriptor",
  "$ref": "#/$defs/ContentDescriptor",
  "$defs": {
    "Codec": {
      "title": "Codec",
      "type": "string",
      "pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern-flags": "u"
    },
    "content_address_contract_1": {
      "title": "content_address_contract_1",
      "type": "string",
      "enum": [
        "ContentDescriptor"
      ]
    },
    "ContentAddress_Codec": {
      "title": "ContentAddress_Codec",
      "type": "string",
      "pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern-flags": "u"
    },
    "ContentAddress_NonNegativeInt": {
      "title": "ContentAddress_NonNegativeInt",
      "type": "string",
      "pattern": "^(0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|90070[0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|9007199254740990|9007199254740991)$",
      "x-effect-rust-pattern": "^(0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|90070[0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|9007199254740990|9007199254740991)$",
      "x-effect-rust-pattern-flags": "u"
    },
    "ContentDescriptor": {
      "title": "ContentDescriptor",
      "type": "object",
      "properties": {
        "_tag": {
          "$ref": "#/$defs/content_address_contract_1"
        },
        "digest": {
          "$ref": "#/$defs/ContentDigest"
        },
        "byteLength": {
          "$ref": "#/$defs/NonNegativeInt"
        },
        "mediaType": {
          "$ref": "#/$defs/MediaType"
        },
        "codec": {
          "$ref": "#/$defs/ContentAddress_Codec"
        },
        "schemaVersion": {
          "$ref": "#/$defs/ContentAddress_NonNegativeInt"
        }
      },
      "required": [
        "_tag",
        "digest",
        "byteLength",
        "mediaType"
      ],
      "additionalProperties": false,
      "x-effect-rust-excess": "error"
    },
    "ContentDigest": {
      "title": "ContentDigest",
      "type": "string",
      "pattern": "^sha256:[a-f0-9]{64}$",
      "x-effect-rust-pattern": "^sha256:[a-f0-9]{64}$",
      "x-effect-rust-pattern-flags": "u"
    },
    "MediaType": {
      "title": "MediaType",
      "type": "string",
      "pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern": "^[^\t-\r    -     　﻿]([\u0000-􏿿]*[^\t-\r    -     　﻿])?$",
      "x-effect-rust-pattern-flags": "u"
    },
    "NonNegativeInt": {
      "title": "NonNegativeInt",
      "type": "string",
      "pattern": "^(0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|90070[0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|9007199254740990|9007199254740991)$",
      "x-effect-rust-pattern": "^(0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|90070[0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|9007199254740990|9007199254740991)$",
      "x-effect-rust-pattern-flags": "u"
    }
  }
}
"###).expect("compiled schema");
    let definitions = document["$defs"].as_object().expect("compiled definitions");
    for (key, value) in definitions { generator.definitions_mut().entry(key.clone()).or_insert_with(|| value.clone()); }
    schemars::Schema::try_from(definitions[name].clone()).expect("compiled definition")
}
impl schemars::JsonSchema for super::Codec {
    fn schema_name() -> std::borrow::Cow<'static, str> { "Codec".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("Codec", generator) }
}
impl schemars::JsonSchema for super::ContentAddressContract1 {
    fn schema_name() -> std::borrow::Cow<'static, str> { "content_address_contract_1".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("content_address_contract_1", generator) }
}
impl schemars::JsonSchema for super::ContentAddressCodec {
    fn schema_name() -> std::borrow::Cow<'static, str> { "ContentAddress_Codec".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("ContentAddress_Codec", generator) }
}
impl schemars::JsonSchema for super::ContentAddressNonNegativeInt {
    fn schema_name() -> std::borrow::Cow<'static, str> { "ContentAddress_NonNegativeInt".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("ContentAddress_NonNegativeInt", generator) }
}
impl schemars::JsonSchema for super::ContentDescriptor {
    fn schema_name() -> std::borrow::Cow<'static, str> { "ContentDescriptor".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("ContentDescriptor", generator) }
}
impl schemars::JsonSchema for super::ContentDigest {
    fn schema_name() -> std::borrow::Cow<'static, str> { "ContentDigest".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("ContentDigest", generator) }
}
impl schemars::JsonSchema for super::MediaType {
    fn schema_name() -> std::borrow::Cow<'static, str> { "MediaType".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("MediaType", generator) }
}
impl schemars::JsonSchema for super::NonNegativeInt {
    fn schema_name() -> std::borrow::Cow<'static, str> { "NonNegativeInt".into() }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema { schema("NonNegativeInt", generator) }
}
