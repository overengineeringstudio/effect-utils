import type { Width } from './ir.ts'

/** Internal support requirements of the emitted contract definitions. */
export interface RustSupportFeatures {
  readonly u64: boolean
  readonly i64: boolean
  readonly f32: boolean
  readonly timestamp: boolean
  readonly patch: boolean
  readonly bounded: readonly (Width | 'number-u64' | 'number-i64')[]
}

/** Self-contained support emitted into each contract crate; strict JSON support is always present. */
export const rustSupport = (features: RustSupportFeatures): string => String.raw`
#![forbid(unsafe_code)]
use serde::{Deserialize, Serialize};

pub type U8 = u8;
pub type U16 = u16;
pub type U32 = u32;
pub type I8 = i8;
pub type I16 = i16;
pub type I32 = i32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError { pub path: String, pub message: String }
impl ValidationError {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}
impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.path, self.message) }
}
impl std::error::Error for ValidationError {}

${
  features.f32 === true
    ? String.raw`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct F32(f32);
impl Eq for F32 {}
impl F32 {
    pub fn new(value: f64) -> Result<Self, ValidationError> {
        let rounded = value as f32;
        if !value.is_finite() || !rounded.is_finite() { return Err(ValidationError::new("", "f32 overflow or non-finite input")); }
        Ok(Self(rounded))
    }
    pub fn get(self) -> f32 { self.0 }
}
impl Serialize for F32 {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_f64(f64::from(self.0)) }
}
impl<'de> Deserialize<'de> for F32 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(<f64 as Deserialize>::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}
impl borsh::BorshSerialize for F32 {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> { borsh::BorshSerialize::serialize(&self.0, writer) }
}
impl borsh::BorshDeserialize for F32 {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        Self::new(f64::from(<f32 as borsh::BorshDeserialize>::deserialize_reader(reader)?))
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }
}
`
    : ''
}

${
  features.u64 === true || features.i64 === true
    ? String.raw`
macro_rules! decimal {
    ($name:ident, $native:ty, $signed:expr) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, borsh::BorshSerialize, borsh::BorshDeserialize)]
        #[borsh(crate = "borsh")]
        pub struct $name(pub $native);
        impl From<$native> for $name { fn from(value: $native) -> Self { Self(value) } }
        impl From<$name> for $native { fn from(value: $name) -> Self { value.0 } }
        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                if serializer.is_human_readable() { serializer.collect_str(&self.0) }
                else if $signed { serializer.serialize_i128(self.0 as i128) }
                else { serializer.serialize_u128(self.0 as u128) }
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct TextVisitor;
                impl serde::de::Visitor<'_> for TextVisitor {
                    type Value = $name;
                    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        write!(f, "a canonical base-10 {} string", stringify!($native))
                    }
                    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
                        let digits = if $signed { text.strip_prefix('-').unwrap_or(text) } else { text };
                        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit())
                            || (digits.len() > 1 && digits.starts_with('0')) || text == "-0" {
                            return Err(E::custom(concat!("expected canonical ", stringify!($native), " decimal string")));
                        }
                        text.parse::<$native>().map($name).map_err(E::custom)
                    }
                    fn visit_i128<E: serde::de::Error>(self, value: i128) -> Result<Self::Value, E> {
                        <$native>::try_from(value).map($name).map_err(E::custom)
                    }
                    fn visit_u128<E: serde::de::Error>(self, value: u128) -> Result<Self::Value, E> {
                        <$native>::try_from(value).map($name).map_err(E::custom)
                    }
                }
                if deserializer.is_human_readable() { deserializer.deserialize_str(TextVisitor) }
                else if $signed { deserializer.deserialize_i128(TextVisitor) }
                else { deserializer.deserialize_u128(TextVisitor) }
            }
        }
    };
}
${features.u64 === true ? 'decimal!(U64, u64, false);' : ''}
${features.i64 === true ? 'decimal!(I64, i64, true);' : ''}
`
    : ''
}
${
  features.bounded.length === 0
    ? ''
    : String.raw`
// Keep authored bounds independent of storage width. Every construction path validates,
// including binary decoding; the private native field cannot bypass the invariant.
macro_rules! bounded_integer {
    ($name:ident, $native:ty, $repr:ty, $wrap:expr, $unwrap:expr) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name<const MIN: $native, const MAX: $native>($native);
        impl<const MIN: $native, const MAX: $native> $name<MIN, MAX> {
            pub fn new(value: $native) -> Result<Self, ValidationError> {
                if MIN > MAX || value < MIN || value > MAX {
                    return Err(ValidationError::new("$", format!("integer must be in {MIN}..={MAX}")));
                }
                Ok(Self(value))
            }
            pub fn into_inner(self) -> $native { self.0 }
            pub fn as_inner(&self) -> &$native { &self.0 }
        }
        impl<const MIN: $native, const MAX: $native> TryFrom<$native> for $name<MIN, MAX> {
            type Error = ValidationError;
            fn try_from(value: $native) -> Result<Self, Self::Error> { Self::new(value) }
        }
        impl<const MIN: $native, const MAX: $native> Serialize for $name<MIN, MAX> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let value: $repr = ($wrap)(self.0);
                Serialize::serialize(&value, serializer)
            }
        }
        impl<'de, const MIN: $native, const MAX: $native> Deserialize<'de> for $name<MIN, MAX> {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <$repr as Deserialize>::deserialize(deserializer)?;
                Self::new(($unwrap)(value)).map_err(serde::de::Error::custom)
            }
        }
        impl<const MIN: $native, const MAX: $native> borsh::BorshSerialize for $name<MIN, MAX> {
            fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
                borsh::BorshSerialize::serialize(&self.0, writer)
            }
        }
        impl<const MIN: $native, const MAX: $native> borsh::BorshDeserialize for $name<MIN, MAX> {
            fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
                let value = <$native as borsh::BorshDeserialize>::deserialize_reader(reader)?;
                Self::new(value).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
            }
        }
    };
}
${features.bounded
  .map((key) => {
    const numeric64 = key === 'number-u64' || key === 'number-i64'
    const width = numeric64 === true ? key.slice(7) : key
    const decimal = numeric64 === false && (width === 'u64' || width === 'i64')
    return `bounded_integer!(Bounded${numeric64 === true ? 'Number' : ''}${width.toUpperCase()}, ${width}, ${decimal === true ? width.toUpperCase() : width}, ${decimal === true ? width.toUpperCase() : `|value: ${width}| value`}, |value: ${decimal === true ? width.toUpperCase() : width}| ${decimal === true ? 'value.0' : 'value'});`
  })
  .join('\n')}
`
}

${
  features.timestamp === true
    ? String.raw`
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TimestampMillis(chrono::DateTime<chrono::Utc>);
impl TimestampMillis {
    pub fn new(value: chrono::DateTime<chrono::Utc>) -> Result<Self, ValidationError> {
        use chrono::{Datelike, Timelike};
        if !(0..=9999).contains(&value.year()) || value.nanosecond() >= 1_000_000_000 || value.nanosecond() % 1_000_000 != 0 {
            return Err(ValidationError::new("$", "timestamp must have millisecond precision, no leap second and a four-digit year"));
        }
        Ok(Self(value))
    }
    pub fn as_datetime(&self) -> &chrono::DateTime<chrono::Utc> { &self.0 }
    pub fn into_inner(self) -> chrono::DateTime<chrono::Utc> { self.0 }
}
impl std::str::FromStr for TimestampMillis {
    type Err = ValidationError;
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        static SHAPE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(||
            regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$").expect("static timestamp regex"));
        if !SHAPE.is_match(text) { return Err(ValidationError::new("$", "expected RFC3339 timestamp with explicit zone")); }
        // Chrono truncates fractional tails after nine digits; reject nonzero submillisecond digits before parsing.
        if let Some((_, fraction)) = text.split_once('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit);
            if digits.skip(3).any(|digit| digit != b'0') {
                return Err(ValidationError::new("$", "submillisecond timestamp precision is not portable"));
            }
        }
        let value = chrono::DateTime::parse_from_rfc3339(text)
            .map_err(|error| ValidationError::new("$", error.to_string()))?;
        Self::new(value.with_timezone(&chrono::Utc))
    }
}
impl Serialize for TimestampMillis {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            serializer.serialize_str(&self.0.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        } else { serializer.serialize_f64(self.0.timestamp_millis() as f64) }
    }
}
impl<'de> Deserialize<'de> for TimestampMillis {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TextVisitor;
        impl serde::de::Visitor<'_> for TextVisitor {
            type Value = TimestampMillis;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("an RFC3339 millisecond timestamp") }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> { value.parse().map_err(E::custom) }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 {
                    return Err(E::custom("expected integral epoch milliseconds"));
                }
                let date = chrono::DateTime::from_timestamp_millis(value as i64).ok_or_else(|| E::custom("unrepresentable timestamp"))?;
                TimestampMillis::new(date).map_err(E::custom)
            }
        }
        if deserializer.is_human_readable() { deserializer.deserialize_str(TextVisitor) }
        else { deserializer.deserialize_f64(TextVisitor) }
    }
}
impl borsh::BorshSerialize for TimestampMillis {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        borsh::BorshSerialize::serialize(&self.0.timestamp_millis(), writer)
    }
}
impl borsh::BorshDeserialize for TimestampMillis {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let millis = <i64 as borsh::BorshDeserialize>::deserialize_reader(reader)?;
        let value = chrono::DateTime::from_timestamp_millis(millis)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "timestamp out of range"))?;
        Self::new(value).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }
}
`
    : ''
}

${
  features.patch === true
    ? String.raw`
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, borsh::BorshSerialize, borsh::BorshDeserialize)]
#[borsh(crate = "borsh")]
pub enum Patch<T> { #[default] Absent, Null, Value(T) }
impl<T> Patch<T> { pub fn is_absent(&self) -> bool { matches!(self, Self::Absent) } }
impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Absent => Err(serde::ser::Error::custom("Patch::Absent must be omitted by its containing field")),
            Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(|value| value.map_or(Self::Null, Self::Value))
    }
}
`
    : ''
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, borsh::BorshSerialize, borsh::BorshDeserialize)]
#[borsh(crate = "borsh")]
pub struct Null;
impl Serialize for Null {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_unit() }
}
impl<'de> Deserialize<'de> for Null {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        <() as Deserialize>::deserialize(deserializer).map(|()| Self)
    }
}

#[doc(hidden)]
pub fn required<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<T, D::Error> {
    T::deserialize(deserializer)
}
#[doc(hidden)]
pub fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[doc(hidden)]
pub mod tagged {
    use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, Visitor, value::MapAccessDeserializer};
    use std::{fmt, marker::PhantomData};
    pub trait TaggedUnion: Sized {
        const NAME: &'static str;
        const TAG_FIELD: &'static str;
        const TAGS: &'static [&'static str];
        fn deserialize_variant<'de, D: Deserializer<'de>>(index: usize, payload: D) -> Result<Self, D::Error>;
    }
    fn tag_index<T: TaggedUnion, E: de::Error>(tag: &str) -> Result<usize, E> {
        T::TAGS.iter().position(|known| *known == tag).ok_or_else(|| E::unknown_variant(tag, T::TAGS))
    }
    struct TagSeed<T>(PhantomData<T>);
    impl<'de, T: TaggedUnion> DeserializeSeed<'de> for TagSeed<T> {
        type Value = usize;
        fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<usize, D::Error> {
            let tag = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
            tag_index::<T, D::Error>(&tag)
        }
    }
    struct TaggedVisitor<T>(PhantomData<T>);
    impl<'de, T: TaggedUnion> Visitor<'de> for TaggedVisitor<T> {
        type Value = T;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "a {} object tagged by {}", T::NAME, T::TAG_FIELD) }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
            let first = map.next_key::<String>()?.ok_or_else(|| de::Error::missing_field(T::TAG_FIELD))?;
            if first == T::TAG_FIELD {
                let index = map.next_value_seed(TagSeed::<T>(PhantomData))?;
                return T::deserialize_variant(index, MapAccessDeserializer::new(map));
            }
            // Noncanonical tag-last input remains accepted, as in A-stream; canonical control messages take the streaming path above.
            let mut object = serde_json::Map::new();
            object.insert(first, map.next_value()?);
            while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                if object.contains_key(&key) { return Err(de::Error::custom(format_args!("duplicate field {key}"))); }
                object.insert(key, value);
            }
            let tag = match object.remove(T::TAG_FIELD) {
                Some(serde_json::Value::String(tag)) => tag,
                _ => return Err(de::Error::custom("missing or non-string discriminant")),
            };
            let index = tag_index::<T, A::Error>(&tag)?;
            T::deserialize_variant(index, serde_json::Value::Object(object)).map_err(de::Error::custom)
        }
    }
    pub fn deserialize<'de, T: TaggedUnion, D: Deserializer<'de>>(deserializer: D) -> Result<T, D::Error> {
        deserializer.deserialize_struct(T::NAME, &[T::TAG_FIELD], TaggedVisitor::<T>(PhantomData))
    }
}

// Validate strict I-JSON without buffering values; typed decoding remains streaming and preserves serde paths.
struct StrictSeed { depth: usize }
impl<'de> serde::de::DeserializeSeed<'de> for StrictSeed {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}
impl<'de> serde::de::Visitor<'de> for StrictSeed {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("strict I-JSON") }
    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> { Ok(()) }
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<(), E> { Ok(()) }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<(), E> { Ok(()) }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<(), E> {
        ${features.f32 === true ? 'let _ = value; // Typed integer fields enforce their own safe bounds; f32 admits numeric rounding.' : 'if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) { return Err(E::custom("unsafe JSON integer; use a width-annotated decimal string")); }'}
        Ok(())
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<(), E> {
        ${features.f32 === true ? 'let _ = value; // Typed integer fields enforce their own safe bounds; f32 admits numeric rounding.' : 'if value > 9_007_199_254_740_991 { return Err(E::custom("unsafe JSON integer; use a width-annotated decimal string")); }'}
        Ok(())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<(), E> {
        if !value.is_finite() { return Err(E::custom("non-finite JSON number")); }
        ${features.f32 === true ? 'Ok(())' : 'Err(E::custom("JSON integers must use canonical base-10 notation"))'}
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        if self.depth >= 128 { return Err(serde::de::Error::custom("JSON depth exceeds 128")); }
        while seq.next_element_seed(StrictSeed { depth: self.depth + 1 })?.is_some() {}
        Ok(())
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        if self.depth >= 128 { return Err(serde::de::Error::custom("JSON depth exceeds 128")); }
        let mut keys = std::collections::BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) { return Err(serde::de::Error::custom("duplicate object key")); }
            map.next_value_seed(StrictSeed { depth: self.depth + 1 })?;
        }
        Ok(())
    }
}
/// Decode strict I-JSON and validate the selected contract, retaining nested serde error paths.
pub fn decode_json<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, ValidationError> {
    use serde::de::DeserializeSeed;
    let mut strict = serde_json::Deserializer::from_str(input);
    strict.disable_recursion_limit();
    let mut track = serde_path_to_error::Track::new();
    StrictSeed { depth: 0 }.deserialize(serde_path_to_error::Deserializer::new(&mut strict, &mut track))
        .map_err(|error| ValidationError::new(format!("$.{}", track.path()), error.to_string()))?;
    strict.end().map_err(|error| ValidationError::new("$", error.to_string()))?;
    let mut deserializer = serde_json::Deserializer::from_str(input);
    deserializer.disable_recursion_limit();
    let value = serde_path_to_error::deserialize(&mut deserializer)
        .map_err(|error| ValidationError::new(format!("$.{}", error.path()), error.inner().to_string()))?;
    deserializer.end().map_err(|error| ValidationError::new("$", error.to_string()))?;
    Ok(value)
}

struct Canonical<'a>(&'a serde_json::Value);
impl Serialize for Canonical<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self.0 {
            serde_json::Value::Object(object) => {
                let mut map = serializer.serialize_map(Some(object.len()))?;
                let tag = TAG_FIELDS.iter().find(|key| matches!(object.get(**key), Some(serde_json::Value::String(_))));
                if let Some(key) = tag { map.serialize_entry(*key, &Canonical(&object[*key]))?; }
                // UTF-16 ordering matches the JS canonical encoder. Rust's BTreeMap order already agrees for BMP-only keys.
                if object.keys().any(|key| key.chars().any(|character| character as u32 >= 0x10000)) {
                    let mut entries: Vec<_> = object.iter().collect();
                    entries.sort_unstable_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
                    for (key, value) in entries { if tag.is_none_or(|tag| *tag != key) { map.serialize_entry(key, &Canonical(value))?; } }
                } else {
                    for (key, value) in object { if tag.is_none_or(|tag| *tag != key) { map.serialize_entry(key, &Canonical(value))?; } }
                }
                map.end()
            }
            serde_json::Value::Array(array) => {
                let mut seq = serializer.serialize_seq(Some(array.len()))?;
                for value in array { seq.serialize_element(&Canonical(value))?; }
                seq.end()
            }
            ${features.f32 === true ? String.raw`serde_json::Value::Number(number) if number.is_f64() => {
                let text = ryu_js::Buffer::new().format_finite(number.as_f64().expect("finite number")).to_owned();
                serde_json::value::RawValue::from_string(text).map_err(serde::ser::Error::custom)?.serialize(serializer)
            }` : ''}
            other => other.serialize(serializer),
        }
    }
}
/// Encode canonical JSON: sorted keys, discriminants first, decimal strings and UTC millisecond timestamps.
pub fn encode_json<T: Serialize>(value: &T) -> Result<String, ValidationError> {
    let value = serde_json::to_value(value).map_err(|error| ValidationError::new("$", error.to_string()))?;
    serde_json::to_string(&Canonical(&value)).map_err(|error| ValidationError::new("$", error.to_string()))
}

/// Mandatory Borsh framing: contract ID u32 LE, version u16 LE, followed by the payload.
pub fn encode_frame<T: borsh::BorshSerialize>(value: &T, contract_id: u32, version: u16) -> Result<Vec<u8>, ValidationError> {
    let mut output = Vec::new();
    output.extend_from_slice(&contract_id.to_le_bytes());
    output.extend_from_slice(&version.to_le_bytes());
    borsh::BorshSerialize::serialize(value, &mut output).map_err(|error| ValidationError::new("$/payload", error.to_string()))?;
    Ok(output)
}
pub fn decode_frame<T: borsh::BorshDeserialize>(input: &[u8], contract_id: u32, version: u16) -> Result<T, ValidationError> {
    if input.len() < 6 { return Err(ValidationError::new("$/header", "truncated frame header")); }
    if input[..4] != contract_id.to_le_bytes() { return Err(ValidationError::new("$/header/contractId", "contract ID mismatch")); }
    if input[4..6] != version.to_le_bytes() { return Err(ValidationError::new("$/header/version", "version mismatch")); }
    borsh::from_slice(&input[6..]).map_err(|error| ValidationError::new("$/payload", error.to_string()))
}
`
