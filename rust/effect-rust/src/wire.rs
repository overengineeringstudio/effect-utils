//! Strict field adapters and semantic types for the JSON control plane.
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}

impl ValidationError {
    #[must_use]
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self { path: path.into(), message: message.into() }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() { formatter.write_str(&self.message) } else { write!(formatter, "{}: {}", self.path, self.message) }
    }
}

impl std::error::Error for ValidationError {}

fn canonical_unsigned(text: &str) -> bool {
    match text.as_bytes() {
        [] => false,
        [b'0'] => true,
        [b'0', ..] => false,
        digits => digits.iter().all(u8::is_ascii_digit),
    }
}

macro_rules! decimal_module {
    ($module:ident, $integer:ty, $canonical:expr, $expecting:literal) => {
        pub mod $module {
            use super::*;

            /// # Errors
            /// Rejects non-canonical spellings and values outside the integer width.
            pub fn parse(text: &str) -> Result<$integer, ValidationError> {
                if !($canonical)(text) {
                    return Err(ValidationError::new("", $expecting));
                }
                text.parse().map_err(|_| ValidationError::new("", concat!("decimal value is out of range for ", stringify!($integer))))
            }

            /// # Errors
            /// Propagates serializer failures.
            pub fn serialize<S: Serializer>(value: &$integer, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(value)
            }

            /// # Errors
            /// Rejects JSON numbers, non-canonical strings, and out-of-range values.
            pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<$integer, D::Error> {
                struct DecimalVisitor;
                impl de::Visitor<'_> for DecimalVisitor {
                    type Value = $integer;
                    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                        formatter.write_str($expecting)
                    }
                    fn visit_str<E: de::Error>(self, text: &str) -> Result<Self::Value, E> {
                        parse(text).map_err(E::custom)
                    }
                }
                deserializer.deserialize_str(DecimalVisitor)
            }
        }
    };
}

decimal_module!(u64_decimal, u64, canonical_unsigned, "a canonical base-10 u64 string");
decimal_module!(i64_decimal, i64, |text: &str| canonical_unsigned(text.strip_prefix('-').unwrap_or(text)) && text != "-0", "a canonical base-10 i64 string");

/// A UTC instant with millisecond precision and a four-digit wire year.
///
/// Decoding accepts explicit RFC3339 zones and any fractional spelling that
/// carries no sub-millisecond precision. Encoding always emits `.sssZ` in UTC.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TimestampMillis(i64);

impl TimestampMillis {
    /// # Errors
    /// Rejects instants outside the RFC3339 four-digit year range.
    pub fn from_unix_millis(millis: i64) -> Result<Self, ValidationError> {
        let date = DateTime::<Utc>::from_timestamp_millis(millis)
            .filter(|date| (0..=9999).contains(&date.year()))
            .ok_or_else(|| ValidationError::new("", "timestamp is outside the four-digit RFC3339 year range"))?;
        Ok(Self(date.timestamp_millis()))
    }

    #[must_use]
    pub const fn as_unix_millis(self) -> i64 {
        self.0
    }
}

impl FromStr for TimestampMillis {
    type Err = ValidationError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let invalid = || ValidationError::new("", "expected an RFC3339 timestamp with explicit zone and millisecond precision");
        let bytes = text.as_bytes();
        let body = if let Some(body) = bytes.strip_suffix(b"Z") {
            body
        } else if bytes.len() >= 25 {
            let (body, zone) = bytes.split_at(bytes.len() - 6);
            if !matches!(zone[0], b'+' | b'-') || zone[3] != b':' || !zone[1..3].iter().all(u8::is_ascii_digit) || !zone[4..6].iter().all(u8::is_ascii_digit) {
                return Err(invalid());
            }
            body
        } else {
            return Err(invalid());
        };
        if body.len() < 19 || body[4] != b'-' || body[7] != b'-' || body[10] != b'T' || body[13] != b':' || body[16] != b':' {
            return Err(invalid());
        }
        for range in [0..4, 5..7, 8..10, 11..13, 14..16, 17..19] {
            if !body[range].iter().all(u8::is_ascii_digit) {
                return Err(invalid());
            }
        }
        if body.len() > 19 {
            if body[19] != b'.' || body.len() == 20 || !body[20..].iter().all(u8::is_ascii_digit) || (body.len() > 23 && body[23..].iter().any(|digit| *digit != b'0')) {
                return Err(invalid());
            }
        }
        let date = DateTime::parse_from_rfc3339(text).map_err(|_| invalid())?;
        if date.nanosecond() >= 1_000_000_000 {
            return Err(ValidationError::new("", "leap seconds are outside the millisecond timestamp profile"));
        }
        Self::from_unix_millis(date.timestamp_millis())
    }
}

impl fmt::Display for TimestampMillis {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The private constructor invariant guarantees both representability and year width.
        let date = DateTime::<Utc>::from_timestamp_millis(self.0).expect("validated timestamp");
        date.format("%Y-%m-%dT%H:%M:%S%.3fZ").fmt(formatter)
    }
}

impl Serialize for TimestampMillis {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for TimestampMillis {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TimestampVisitor;
        impl de::Visitor<'_> for TimestampVisitor {
            type Value = TimestampMillis;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an explicitly zoned RFC3339 millisecond timestamp")
            }
            fn visit_str<E: de::Error>(self, text: &str) -> Result<Self::Value, E> {
                text.parse().map_err(E::custom)
            }
        }
        deserializer.deserialize_str(TimestampVisitor)
    }
}

/// Missing, explicit null, and present are three distinct patch states.
///
/// Fields must use `#[serde(default, skip_serializing_if = "Patch::is_absent")]`.
/// Serializing `Absent` directly is an error: it cannot be represented as a value.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum Patch<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Patch<T> {
    #[must_use]
    pub const fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Absent => Err(serde::ser::Error::custom("absent patch fields must be omitted")),
            Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PatchVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> de::Visitor<'de> for PatchVisitor<T> {
            type Value = Patch<T>;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("null or a present patch value")
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Patch::Null)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Patch::Null)
            }
            fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
                T::deserialize(deserializer).map(Patch::Value)
            }
        }
        deserializer.deserialize_option(PatchVisitor(std::marker::PhantomData))
    }
}

/// Deserializes a field whose key must be present even though its type admits
/// `null` (serde otherwise defaults a missing `Option` field to `None`).
///
/// # Errors
/// Propagates the field type's errors; a missing key fails as `missing field`.
pub fn required<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<T, D::Error> {
    T::deserialize(deserializer)
}

/// Serde field adapter for `chrono::DateTime<Utc>` fields on the millisecond wire.
///
/// Use `#[wire(timestamp_millis)]` inside `#[effect_rust::contract]`, or
/// `#[serde(with = "effect_rust::wire::timestamp_millis")]` directly.
pub mod timestamp_millis {
    use super::{DateTime, Deserialize, Deserializer, Serialize, Serializer, TimestampMillis, Utc};

    /// # Errors
    /// Rejects sub-millisecond precision and instants outside the four-digit year range
    /// instead of silently truncating them.
    pub fn serialize<S: Serializer>(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error> {
        if value.timestamp_subsec_nanos() % 1_000_000 != 0 {
            return Err(serde::ser::Error::custom("timestamp carries sub-millisecond precision"));
        }
        TimestampMillis::from_unix_millis(value.timestamp_millis()).map_err(serde::ser::Error::custom)?.serialize(serializer)
    }

    /// # Errors
    /// Same admission as [`TimestampMillis`].
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<DateTime<Utc>, D::Error> {
        let timestamp = TimestampMillis::deserialize(deserializer)?;
        // The TimestampMillis invariant guarantees representability.
        DateTime::<Utc>::from_timestamp_millis(timestamp.as_unix_millis()).ok_or_else(|| serde::de::Error::custom("unrepresentable timestamp"))
    }
}

const MAX_DEPTH: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Normalize JavaScript's number representation only at object transport boundaries.
///
/// Safe integral doubles become serde integers; fractional and unsafe numbers
/// remain floats so integer contracts reject them. JSON-text admission is unchanged.
pub fn normalize_js_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) if number.is_f64() => {
            let value = number.as_f64().expect("f64 JSON number");
            if value.is_finite() && value.fract() == 0.0
                && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&value) {
                #[allow(clippy::cast_possible_truncation)] // Finite integral safe doubles fit i64 exactly.
                let integer = value as i64;
                *number = serde_json::Number::from(integer);
            }
        }
        serde_json::Value::Array(values) => values.iter_mut().for_each(normalize_js_numbers),
        serde_json::Value::Object(values) => values.values_mut().for_each(normalize_js_numbers),
        _ => {}
    }
}

/// Strict I-JSON admission: unique keys, safe canonical integers, bounded depth.
/// Validates without building values; typed decoding then streams separately.
struct StrictSeed {
    depth: usize,
}

impl<'de> de::DeserializeSeed<'de> for StrictSeed {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> de::Visitor<'de> for StrictSeed {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("strict I-JSON")
    }
    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<(), E> {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom("unsafe JSON integer; use a width-annotated decimal string"));
        }
        Ok(())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<(), E> {
        if value > MAX_SAFE_INTEGER {
            return Err(E::custom("unsafe JSON integer; use a width-annotated decimal string"));
        }
        Ok(())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        Err(E::custom("JSON numbers must be canonical integers"))
    }
    fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        if self.depth >= MAX_DEPTH {
            return Err(de::Error::custom("JSON depth exceeds 128"));
        }
        while seq.next_element_seed(StrictSeed { depth: self.depth + 1 })?.is_some() {}
        Ok(())
    }
    fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        if self.depth >= MAX_DEPTH {
            return Err(de::Error::custom("JSON depth exceeds 128"));
        }
        let mut keys = std::collections::BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            map.next_value_seed(StrictSeed { depth: self.depth + 1 })?;
        }
        Ok(())
    }
}

/// Decodes strict I-JSON text into a contract type, keeping nested error paths.
///
/// Objects may use any key order; tagged unions take a streaming fast path when
/// their tag key comes first (see [`crate::tagged`]).
///
/// # Errors
/// Returns the `$`-rooted path and reason of the first violation.
pub fn decode_json<T: de::DeserializeOwned>(input: &str) -> Result<T, ValidationError> {
    use de::DeserializeSeed as _;
    // serde_json's own nesting limit (128) coincides with the I-JSON profile's depth bound.
    let mut strict = serde_json::Deserializer::from_str(input);
    let mut track = serde_path_to_error::Track::new();
    StrictSeed { depth: 0 }
        .deserialize(serde_path_to_error::Deserializer::new(&mut strict, &mut track))
        .map_err(|error| ValidationError::new(rooted(&track.path()), error.to_string()))?;
    strict.end().map_err(|error| ValidationError::new("$", error.to_string()))?;
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let value = serde_path_to_error::deserialize(&mut deserializer)
        .map_err(|error| ValidationError::new(rooted(error.path()), error.inner().to_string()))?;
    deserializer.end().map_err(|error| ValidationError::new("$", error.to_string()))?;
    Ok(value)
}

fn rooted(path: &serde_path_to_error::Path) -> String {
    let path = path.to_string();
    if path == "." { "$".to_owned() } else { format!("$.{path}") }
}

/// Canonical JSON view: the first present tag key (string-valued) leads, then the
/// remaining keys in UTF-16 code-unit order, matching the Effect encoder.
struct Canonical<'a> {
    value: &'a serde_json::Value,
    tag_fields: &'a [&'a str],
}

impl Serialize for Canonical<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap as _, SerializeSeq as _};
        let nested = |value| Canonical { value, tag_fields: self.tag_fields };
        match self.value {
            serde_json::Value::Object(object) => {
                let tag = self.tag_fields.iter().copied().find(|key| matches!(object.get(*key), Some(serde_json::Value::String(_))));
                let mut entries: Vec<_> = object.iter().filter(|(key, _)| Some(key.as_str()) != tag).collect();
                entries.sort_unstable_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
                let mut map = serializer.serialize_map(Some(object.len()))?;
                if let Some(key) = tag {
                    map.serialize_entry(key, &object[key])?;
                }
                for (key, value) in entries {
                    map.serialize_entry(key, &nested(value))?;
                }
                map.end()
            }
            serde_json::Value::Array(array) => {
                let mut seq = serializer.serialize_seq(Some(array.len()))?;
                for value in array {
                    seq.serialize_element(&nested(value))?;
                }
                seq.end()
            }
            other => other.serialize(serializer),
        }
    }
}

/// Encodes canonical JSON: the union tag key first, then remaining keys sorted.
///
/// `tag_fields` lists the discriminator keys used by the contract set (normally
/// one, e.g. `&["kind"]`); objects carrying none of them are fully sorted.
///
/// # Errors
/// Propagates serialization failures such as an unomitted `Patch::Absent`.
pub fn encode_json<T: Serialize + ?Sized>(value: &T, tag_fields: &[&str]) -> Result<String, ValidationError> {
    let value = serde_json::to_value(value).map_err(|error| ValidationError::new("$", error.to_string()))?;
    serde_json::to_string(&Canonical { value: &value, tag_fields }).map_err(|error| ValidationError::new("$", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_numbers_normalize_recursively_without_weakening_json_text() {
        #[derive(Debug, PartialEq, Deserialize)]
        struct Numbers { unsigned: u32, signed: i32, safe: Vec<i64> }
        let mut value = json!({
            "unsigned": 4_294_967_295.0,
            "signed": -2_147_483_648.0,
            "safe": [9_007_199_254_740_991.0, -9_007_199_254_740_991.0, -0.0]
        });
        normalize_js_numbers(&mut value);
        assert_eq!(serde_json::from_value::<Numbers>(value).unwrap(),
            Numbers { unsigned: u32::MAX, signed: i32::MIN, safe: vec![9_007_199_254_740_991, -9_007_199_254_740_991, 0] });
        for number in [1.5, 9_007_199_254_740_992.0, -9_007_199_254_740_992.0] {
            let mut value = json!(number);
            normalize_js_numbers(&mut value);
            assert!(serde_json::from_value::<i64>(value).is_err());
        }
        for text in ["1.0", "1e0", "-0.0"] {
            assert!(decode_json::<u32>(text).is_err(), "accepted noncanonical text {text}");
        }
        assert_eq!(decode_json::<u32>("1").unwrap(), 1);
    }

    #[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Integers {
        #[serde(with = "u64_decimal")]
        unsigned: u64,
        #[serde(with = "i64_decimal")]
        signed: i64,
    }

    #[test]
    fn wide_integer_boundaries_roundtrip_as_strings() {
        for value in [Integers { unsigned: 0, signed: 0 }, Integers { unsigned: u64::MAX, signed: i64::MIN }, Integers { unsigned: 9_007_199_254_740_993, signed: i64::MAX }] {
            let json = serde_json::to_value(&value).unwrap();
            assert_eq!(json, json!({"unsigned": value.unsigned.to_string(), "signed": value.signed.to_string()}));
            assert_eq!(serde_json::from_value::<Integers>(json).unwrap(), value);
        }
    }

    #[test]
    fn noncanonical_and_out_of_width_integers_are_rejected() {
        for text in ["", "00", "01", "+1", "-0", " 1", "1 ", "1.0", "1e0", "١", "18446744073709551616"] {
            assert!(u64_decimal::parse(text).is_err(), "accepted unsigned {text:?}");
        }
        for text in ["", "00", "-00", "-01", "+1", "-0", " 1", "1.0", "1e0", "9223372036854775808", "-9223372036854775809"] {
            assert!(i64_decimal::parse(text).is_err(), "accepted signed {text:?}");
        }
        for value in [json!({"unsigned": 1, "signed": "1"}), json!({"unsigned": "1", "signed": 1}), json!({"unsigned": null, "signed": "1"})] {
            assert!(serde_json::from_value::<Integers>(value).is_err());
        }
    }

    #[test]
    fn timestamps_normalize_offsets_and_exact_millisecond_precision() {
        for (input, expected) in [
            ("1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z"),
            ("2026-10-01T03:04:05.1+02:30", "2026-10-01T00:34:05.100Z"),
            ("2026-10-01T03:04:05.12-02:30", "2026-10-01T05:34:05.120Z"),
            ("2026-10-01T03:04:05.123000Z", "2026-10-01T03:04:05.123Z"),
            ("1969-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z"),
        ] {
            let timestamp: TimestampMillis = serde_json::from_value(json!(input)).unwrap();
            assert_eq!(timestamp.to_string(), expected);
            assert_eq!(serde_json::to_value(timestamp).unwrap(), json!(expected));
        }
        assert_eq!(TimestampMillis::from_unix_millis(-1).unwrap().as_unix_millis(), -1);
    }

    #[test]
    fn invalid_dates_zones_submillis_and_unrepresentable_instants_are_rejected() {
        for text in ["2026-10-01T03:04:05", "2026-10-01T03:04:05.1234Z", "2026-10-01T03:04:05.000000001Z", "2026-02-29T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T03:04:05+24:00", "2026-10-01T03:04:05.Z", "2016-12-31T23:59:60Z", "10000-01-01T00:00:00Z", "9999-12-31T23:59:59-01:00"] {
            assert!(text.parse::<TimestampMillis>().is_err(), "accepted {text}");
        }
        assert!(TimestampMillis::from_unix_millis(i64::MAX).is_err());
        assert!(serde_json::from_value::<TimestampMillis>(json!(0)).is_err());
    }

    #[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Update {
        #[serde(default, skip_serializing_if = "Patch::is_absent")]
        name: Patch<String>,
    }

    #[test]
    fn patch_preserves_absent_null_and_present_states() {
        for (value, expected) in [(json!({}), Patch::Absent), (json!({"name": null}), Patch::Null), (json!({"name": "Ada"}), Patch::Value("Ada".to_owned()))] {
            let update: Update = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(update.name, expected);
            assert_eq!(serde_json::to_value(&update).unwrap(), value);
        }
        assert!(serde_json::to_value(Patch::<String>::Absent).is_err());
        assert!(serde_json::from_value::<Update>(json!({"name": 1})).is_err());
        assert!(serde_json::from_value::<Update>(json!({"extra": true})).is_err());
    }
}
