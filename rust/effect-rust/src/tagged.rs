//! Internally tagged union decoding that keeps nested error paths.
//!
//! serde's `#[serde(tag = "...")]` buffers every variant into private content,
//! which reports payload errors at the union root. Decoders accept any key order:
//! when the tag key comes first (what every effect-rust encoder emits) the rest of
//! the map streams straight into the variant payload, keeping serde paths and
//! line/column positions. Otherwise the object is buffered and decoded after the
//! tag is found, which is correct but reports payload errors without a nested path.
//!
//! `#[effect_rust::contract]` implements [`TaggedUnion`] for tagged enums; the
//! trait is public so hand-written contracts can opt into the same decoder.

use serde::de::{
    self, value::MapAccessDeserializer, DeserializeSeed, Deserializer, MapAccess, Visitor,
};
use std::fmt;
use std::marker::PhantomData;

pub trait TaggedUnion: Sized {
    /// Union name used in error messages.
    const NAME: &'static str;
    /// Wire discriminator key, for example `kind` or `_tag`.
    const TAG_FIELD: &'static str;
    /// Wire tags in variant index order.
    const TAGS: &'static [&'static str];

    /// Decodes the payload of `TAGS[index]`: a map without the tag key.
    ///
    /// # Errors
    /// Variant payload errors.
    fn deserialize_variant<'de, D: Deserializer<'de>>(
        index: usize,
        payload: D,
    ) -> Result<Self, D::Error>;
}

/// Decodes a [`TaggedUnion`]; use as the body of its `Deserialize` impl.
///
/// # Errors
/// Missing, duplicate, non-string or unknown tags and variant payload errors.
pub fn deserialize<'de, T: TaggedUnion, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    deserializer.deserialize_map(TaggedVisitor::<T>(PhantomData))
}

fn tag_index<T: TaggedUnion, E: de::Error>(tag: &str) -> Result<usize, E> {
    T::TAGS
        .iter()
        .position(|known| *known == tag)
        .ok_or_else(|| E::unknown_variant(tag, T::TAGS))
}

/// Resolves the tag while the deserializer is positioned on its value, so path
/// trackers attribute unknown or malformed tags to `<path>.<tag field>`.
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

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "a `{}` object tagged by `{}`",
            T::NAME,
            T::TAG_FIELD
        )
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
        let Some(first) = map.next_key::<String>()? else {
            return Err(de::Error::missing_field(T::TAG_FIELD));
        };
        if first == T::TAG_FIELD {
            // Fast path: the remaining entries are exactly the variant payload.
            let index = map.next_value_seed(TagSeed::<T>(PhantomData))?;
            return T::deserialize_variant(index, MapAccessDeserializer::new(map));
        }
        // Fallback: any other key order is valid input; buffer until the tag is known.
        let mut object = serde_json::Map::new();
        object.insert(first, map.next_value()?);
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(de::Error::custom(format_args!("duplicate field `{key}`")));
            }
            let value = map.next_value()?;
            object.insert(key, value);
        }
        let tag = match object.remove(T::TAG_FIELD) {
            Some(serde_json::Value::String(tag)) => tag,
            Some(other) => {
                return Err(de::Error::invalid_type(unexpected(&other), &"a string tag"))
            }
            None => return Err(de::Error::missing_field(T::TAG_FIELD)),
        };
        let index = tag_index::<T, A::Error>(&tag)?;
        T::deserialize_variant(index, serde_json::Value::Object(object)).map_err(de::Error::custom)
    }
}

fn unexpected(value: &serde_json::Value) -> de::Unexpected<'_> {
    match value {
        serde_json::Value::Null => de::Unexpected::Unit,
        serde_json::Value::Bool(value) => de::Unexpected::Bool(*value),
        serde_json::Value::Number(_) => de::Unexpected::Other("number"),
        serde_json::Value::String(value) => de::Unexpected::Str(value),
        serde_json::Value::Array(_) => de::Unexpected::Seq,
        serde_json::Value::Object(_) => de::Unexpected::Map,
    }
}
