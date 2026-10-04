//! JSON-only value tree retaining the distinction between integer and float tokens.
use crate::direct::{Error, Kind, Reader};
use serde::{de, Deserialize, Deserializer};
use std::{collections::BTreeMap, fmt};

pub(super) enum Value {
    Null, Bool(bool), Integer(f64), Float(f64), String(String),
    Array(Vec<Self>), Object(BTreeMap<String, Self>),
}
impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Value;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("a unique-key JSON value") }
            fn visit_unit<E: de::Error>(self) -> Result<Value, E> { Ok(Value::Null) }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> { Ok(Value::Bool(value)) }
            #[allow(clippy::cast_precision_loss)] // Float fields admit numeric rounding; integer readers reject unsafe values.
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
                Ok(Value::Integer(value as f64))
            }
            #[allow(clippy::cast_precision_loss)] // Float fields admit numeric rounding; integer readers reject unsafe values.
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
                Ok(Value::Integer(value as f64))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
                if !value.is_finite() { return Err(E::custom("expected a finite JSON number")); }
                Ok(Value::Float(value))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> { Ok(Value::String(value.to_owned())) }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> { Ok(Value::String(value)) }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? { values.push(value); }
                Ok(Value::Array(values))
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) { return Err(de::Error::custom("duplicate object key")); }
                    values.insert(key, map.next_value()?);
                }
                Ok(Value::Object(values))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
pub(super) struct Json;
impl<'a> Reader for &'a Json {
    type Value = &'a Value;
    fn human_readable(&self) -> bool { true }
    fn kind(&self, value: &Self::Value) -> Result<Kind, Error> {
        Ok(match value { Value::Null => Kind::Null, Value::Bool(_) => Kind::Bool, Value::Integer(_) | Value::Float(_) => Kind::Number,
            Value::String(_) => Kind::String, Value::Array(_) => Kind::Array, Value::Object(_) => Kind::Object })
    }
    fn boolean(&self, value: &Self::Value) -> Result<bool, Error> { if let Value::Bool(value) = value { Ok(*value) } else { Err(Error("expected boolean".into())) } }
    fn number(&self, value: &Self::Value) -> Result<f64, Error> {
        match value { Value::Integer(value) | Value::Float(value) => Ok(*value), _ => Err(Error("expected number".into())) }
    }
    fn integer(&self, value: &Self::Value) -> Result<f64, Error> {
        if let Value::Integer(value) = value {
            if value.abs() > 9_007_199_254_740_991.0 { return Err(Error("unsafe JSON integer; use a width-annotated decimal string".into())); }
            Ok(*value)
        } else { Err(Error("JSON integer fields require a canonical integer token".into())) }
    }
    fn string(&self, value: &Self::Value) -> Result<String, Error> { if let Value::String(value) = value { Ok(value.clone()) } else { Err(Error("expected string".into())) } }
    fn unsigned(&self, _: &Self::Value) -> Result<u64, Error> { Err(Error("JSON wide integers require decimal strings".into())) }
    fn signed(&self, _: &Self::Value) -> Result<i64, Error> { Err(Error("JSON wide integers require decimal strings".into())) }
    fn keys(&self, value: &Self::Value) -> Result<Vec<String>, Error> { if let Value::Object(value) = value { Ok(value.keys().cloned().collect()) } else { Err(Error("expected object".into())) } }
    fn get(&self, value: &Self::Value, key: &str) -> Result<Self::Value, Error> { if let Value::Object(value) = value { value.get(key).ok_or_else(|| Error("missing field".into())) } else { Err(Error("expected object".into())) } }
    fn length(&self, value: &Self::Value) -> Result<usize, Error> { if let Value::Array(value) = value { Ok(value.len()) } else { Err(Error("expected array".into())) } }
    fn element(&self, value: &Self::Value, index: usize) -> Result<Self::Value, Error> { if let Value::Array(value) = value { value.get(index).ok_or_else(|| Error("missing element".into())) } else { Err(Error("expected array".into())) } }
}
