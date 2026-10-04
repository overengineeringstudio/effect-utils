//! Structured in-process serde transport. No intermediate Rust value tree or JSON text.
use serde::{de, ser, Serialize};
use std::fmt;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;
#[cfg(all(feature = "napi", not(target_arch = "wasm32")))]
pub mod native;

#[derive(Debug)]
pub struct Error(pub String);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for Error {}
impl ser::Error for Error { fn custom<T: fmt::Display>(message: T) -> Self { Self(message.to_string()) } }
impl de::Error for Error { fn custom<T: fmt::Display>(message: T) -> Self { Self(message.to_string()) } }

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind { Null, Bool, Number, BigInt, String, Array, Object, Unsupported }

/// JS handle operations; handles remain local to one synchronous adapter entry.
pub trait Reader {
    type Value;
    fn kind(&self, value: &Self::Value) -> Result<Kind, Error>;
    fn boolean(&self, value: &Self::Value) -> Result<bool, Error>;
    fn number(&self, value: &Self::Value) -> Result<f64, Error>;
    fn string(&self, value: &Self::Value) -> Result<String, Error>;
    fn unsigned(&self, value: &Self::Value) -> Result<u64, Error>;
    fn signed(&self, value: &Self::Value) -> Result<i64, Error>;
    fn keys(&self, value: &Self::Value) -> Result<Vec<String>, Error>;
    fn get(&self, value: &Self::Value, key: &str) -> Result<Self::Value, Error>;
    fn length(&self, value: &Self::Value) -> Result<usize, Error>;
    fn element(&self, value: &Self::Value, index: usize) -> Result<Self::Value, Error>;
    fn human_readable(&self) -> bool { false }
    fn integer(&self, value: &Self::Value) -> Result<f64, Error> { self.number(value) }
}
pub trait Writer: Reader {
    fn null(&self) -> Result<Self::Value, Error>;
    fn bool_value(&self, value: bool) -> Result<Self::Value, Error>;
    fn number_value(&self, value: f64) -> Result<Self::Value, Error>;
    fn string_value(&self, value: &str) -> Result<Self::Value, Error>;
    fn unsigned_value(&self, value: u64) -> Result<Self::Value, Error>;
    fn signed_value(&self, value: i64) -> Result<Self::Value, Error>;
    fn object(&self) -> Result<Self::Value, Error>;
    fn array(&self) -> Result<Self::Value, Error>;
    fn put(&self, object: &Self::Value, key: &str, value: Self::Value) -> Result<(), Error>;
    fn push(&self, array: &Self::Value, index: usize, value: Self::Value) -> Result<(), Error>;
}

pub fn decode<T: de::DeserializeOwned, B: Reader>(backend: &B, value: B::Value) -> Result<T, Error> {
    T::deserialize(Decoder { backend, value, depth: 0 })
}
pub fn encode<T: Serialize + ?Sized, B: Writer>(backend: &B, value: &T) -> Result<B::Value, Error> {
    value.serialize(Encoder { backend, depth: 0, error_widths: false })
}
/// Expected-error metadata admits full-range u64/i64 fields without decimal adapters.
pub fn encode_error<T: Serialize + ?Sized, B: Writer>(backend: &B, value: &T) -> Result<B::Value, Error> {
    value.serialize(Encoder { backend, depth: 0, error_widths: true })
}

pub(crate) struct Decoder<'a, B: Reader> { pub(crate) backend: &'a B, pub(crate) value: B::Value, pub(crate) depth: usize }
impl<'a, B: Reader> Decoder<'a, B> {
    fn child(&self, value: B::Value) -> Result<Self, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        Ok(Self { backend: self.backend, value, depth: self.depth + 1 })
    }
    fn numeric(&self) -> Result<f64, Error> {
        if self.backend.kind(&self.value)? != Kind::Number { return Err(Error("expected a number".into())); }
        let value = self.backend.number(&self.value)?;
        if !value.is_finite() { return Err(Error("expected a finite number".into())); }
        Ok(value)
    }
}
macro_rules! integer_decode {
    ($method:ident, $visit:ident, $ty:ty) => {
        fn $method<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            let value = self.backend.integer(&self.value)?;
            if value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0
                || value < <$ty>::MIN as f64 || value > <$ty>::MAX as f64 {
                return Err(Error(concat!("expected a safe ", stringify!($ty), " integer").into()));
            }
            // The explicit integral, safe-number and width checks make this exact.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let value = value as $ty;
            visitor.$visit(value)
        }
    };
}
impl<'de, B: Reader> de::Deserializer<'de> for Decoder<'_, B> {
    type Error = Error;
    fn is_human_readable(&self) -> bool { self.backend.human_readable() }
    fn deserialize_any<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.backend.kind(&self.value)? {
            Kind::Null => visitor.visit_unit(),
            Kind::Bool => visitor.visit_bool(self.backend.boolean(&self.value)?),
            Kind::Number => {
                let value = self.backend.integer(&self.value)?;
                if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
                    #[allow(clippy::cast_possible_truncation)] // Safe integral JS numbers fit i64 exactly.
                    return visitor.visit_i64(value as i64);
                }
                visitor.visit_f64(value)
            }
            Kind::BigInt => Err(Error("bigint requires an explicit 64-bit wire field".into())),
            Kind::String => visitor.visit_string(self.backend.string(&self.value)?),
            Kind::Array => self.deserialize_seq(visitor),
            Kind::Object => self.deserialize_map(visitor),
            Kind::Unsupported => Err(Error("unsupported structured value".into())),
        }
    }
    fn deserialize_bool<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? != Kind::Bool { return Err(Error("expected a boolean".into())); }
        visitor.visit_bool(self.backend.boolean(&self.value)?)
    }
    integer_decode!(deserialize_i8, visit_i8, i8);
    integer_decode!(deserialize_i16, visit_i16, i16);
    integer_decode!(deserialize_i32, visit_i32, i32);
    integer_decode!(deserialize_i64, visit_i64, i64);
    integer_decode!(deserialize_u8, visit_u8, u8);
    integer_decode!(deserialize_u16, visit_u16, u16);
    integer_decode!(deserialize_u32, visit_u32, u32);
    integer_decode!(deserialize_u64, visit_u64, u64);
    // i128/u128 are reserved by the width field adapters for bigint; the portable
    // contract compiler does not admit arbitrary 128-bit fields.
    fn deserialize_i128<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? != Kind::BigInt { return Err(Error("expected an i64 bigint".into())); }
        visitor.visit_i128(i128::from(self.backend.signed(&self.value)?))
    }
    fn deserialize_u128<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? != Kind::BigInt { return Err(Error("expected a u64 bigint".into())); }
        visitor.visit_u128(u128::from(self.backend.unsigned(&self.value)?))
    }
    fn deserialize_f32<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        let value = self.numeric()?;
        #[allow(clippy::cast_possible_truncation)] // Rounding to binary32 is explicit; check the rounded result for overflow.
        let rounded = value as f32;
        if !rounded.is_finite() { return Err(Error("f32 overflow".into())); }
        visitor.visit_f32(rounded)
    }
    fn deserialize_f64<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { visitor.visit_f64(self.numeric()?) }
    fn deserialize_char<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_string(visitor) }
    fn deserialize_str<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_string(visitor) }
    fn deserialize_string<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? != Kind::String { return Err(Error("expected a string".into())); }
        visitor.visit_string(self.backend.string(&self.value)?)
    }
    fn deserialize_bytes<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_seq(visitor) }
    fn deserialize_byte_buf<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_seq(visitor) }
    fn deserialize_option<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? == Kind::Null { visitor.visit_none() } else { visitor.visit_some(self) }
    }
    fn deserialize_unit<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.backend.kind(&self.value)? != Kind::Null { return Err(Error("expected null".into())); }
        visitor.visit_unit()
    }
    fn deserialize_unit_struct<V: de::Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, Error> { self.deserialize_unit(visitor) }
    fn deserialize_newtype_struct<V: de::Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, Error> { visitor.visit_newtype_struct(self) }
    fn deserialize_seq<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        if self.backend.kind(&self.value)? != Kind::Array { return Err(Error("expected an array".into())); }
        let length = self.backend.length(&self.value)?;
        visitor.visit_seq(Sequence { decoder: self, index: 0, length })
    }
    fn deserialize_tuple<V: de::Visitor<'de>>(self, _: usize, visitor: V) -> Result<V::Value, Error> { self.deserialize_seq(visitor) }
    fn deserialize_tuple_struct<V: de::Visitor<'de>>(self, _: &'static str, _: usize, visitor: V) -> Result<V::Value, Error> { self.deserialize_seq(visitor) }
    fn deserialize_map<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_struct("", &[], visitor) }
    fn deserialize_struct<V: de::Visitor<'de>>(self, _: &'static str, fields: &'static [&'static str], visitor: V) -> Result<V::Value, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        if self.backend.kind(&self.value)? != Kind::Object { return Err(Error("expected an object".into())); }
        let mut keys = self.backend.keys(&self.value)?;
        // TaggedUnion requests its discriminator as the only known field. Move
        // that handle first without buffering the payload into a serde value tree.
        if fields.len() == 1 {
            if let Some(index) = keys.iter().position(|key| key == fields[0]) { keys.swap(0, index); }
        }
        visitor.visit_map(Object { decoder: self, keys, index: 0 })
    }
    fn deserialize_enum<V: de::Visitor<'de>>(self, _: &'static str, _: &'static [&'static str], _: V) -> Result<V::Value, Error> { Err(Error("use an internally tagged contract enum".into())) }
    fn deserialize_identifier<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_string(visitor) }
    fn deserialize_ignored_any<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { visitor.visit_unit() }
}
struct Sequence<'a, B: Reader> { decoder: Decoder<'a, B>, index: usize, length: usize }
impl<'de, B: Reader> de::SeqAccess<'de> for Sequence<'_, B> {
    type Error = Error;
    fn next_element_seed<T: de::DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Error> {
        if self.index == self.length { return Ok(None); }
        let value = self.decoder.backend.element(&self.decoder.value, self.index)?;
        self.index += 1;
        seed.deserialize(self.decoder.child(value)?).map(Some)
    }
    fn size_hint(&self) -> Option<usize> { Some(self.length - self.index) }
}
struct Object<'a, B: Reader> { decoder: Decoder<'a, B>, keys: Vec<String>, index: usize }
impl<'de, B: Reader> de::MapAccess<'de> for Object<'_, B> {
    type Error = Error;
    fn next_key_seed<T: de::DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Error> {
        let Some(key) = self.keys.get(self.index) else { return Ok(None); };
        seed.deserialize(de::value::StrDeserializer::<Error>::new(key)).map(Some)
    }
    fn next_value_seed<T: de::DeserializeSeed<'de>>(&mut self, seed: T) -> Result<T::Value, Error> {
        let value = self.decoder.backend.get(&self.decoder.value, &self.keys[self.index])?;
        self.index += 1;
        seed.deserialize(self.decoder.child(value)?)
    }
    fn size_hint(&self) -> Option<usize> { Some(self.keys.len() - self.index) }
}

struct Encoder<'a, B: Writer> { backend: &'a B, depth: usize, error_widths: bool }
impl<'a, B: Writer> Encoder<'a, B> {
    fn child(&self) -> Result<Self, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        Ok(Self { backend: self.backend, depth: self.depth + 1, error_widths: self.error_widths })
    }
}
macro_rules! number_encode {
    ($method:ident, $ty:ty) => {
        fn $method(self, value: $ty) -> Result<B::Value, Error> { self.backend.number_value(f64::from(value)) }
    };
}
impl<'a, B: Writer> ser::Serializer for Encoder<'a, B> {
    type Ok = B::Value;
    type Error = Error;
    type SerializeSeq = Compound<'a, B>;
    type SerializeTuple = Compound<'a, B>;
    type SerializeTupleStruct = Compound<'a, B>;
    type SerializeTupleVariant = ser::Impossible<B::Value, Error>;
    type SerializeMap = Compound<'a, B>;
    type SerializeStruct = Compound<'a, B>;
    type SerializeStructVariant = ser::Impossible<B::Value, Error>;
    fn is_human_readable(&self) -> bool { false }
    fn serialize_bool(self, value: bool) -> Result<B::Value, Error> { self.backend.bool_value(value) }
    number_encode!(serialize_i8, i8); number_encode!(serialize_i16, i16); number_encode!(serialize_i32, i32);
    number_encode!(serialize_u8, u8); number_encode!(serialize_u16, u16); number_encode!(serialize_u32, u32);
    fn serialize_i64(self, value: i64) -> Result<B::Value, Error> {
        if self.error_widths { return self.backend.signed_value(value); }
        if value.unsigned_abs() > 9_007_199_254_740_991 { return Err(Error("unsafe unannotated integer".into())); }
        #[allow(clippy::cast_precision_loss)] // Value is checked in the exactly representable JS integer range.
        self.backend.number_value(value as f64)
    }
    fn serialize_u64(self, value: u64) -> Result<B::Value, Error> {
        if self.error_widths { return self.backend.unsigned_value(value); }
        if value > 9_007_199_254_740_991 { return Err(Error("unsafe unannotated integer".into())); }
        #[allow(clippy::cast_precision_loss)] // Value is checked in the exactly representable JS integer range.
        self.backend.number_value(value as f64)
    }
    fn serialize_i128(self, value: i128) -> Result<B::Value, Error> { self.backend.signed_value(i64::try_from(value).map_err(|_| Error("i64 overflow".into()))?) }
    fn serialize_u128(self, value: u128) -> Result<B::Value, Error> { self.backend.unsigned_value(u64::try_from(value).map_err(|_| Error("u64 overflow".into()))?) }
    fn serialize_f32(self, value: f32) -> Result<B::Value, Error> { self.serialize_f64(f64::from(value)) }
    fn serialize_f64(self, value: f64) -> Result<B::Value, Error> {
        if !value.is_finite() { return Err(Error("non-finite float result".into())); }
        self.backend.number_value(value)
    }
    fn serialize_char(self, value: char) -> Result<B::Value, Error> { self.serialize_str(value.encode_utf8(&mut [0; 4])) }
    fn serialize_str(self, value: &str) -> Result<B::Value, Error> { self.backend.string_value(value) }
    fn serialize_bytes(self, value: &[u8]) -> Result<B::Value, Error> {
        let array = self.backend.array()?;
        for (index, byte) in value.iter().enumerate() { self.backend.push(&array, index, self.backend.number_value(f64::from(*byte))?)?; }
        Ok(array)
    }
    fn serialize_none(self) -> Result<B::Value, Error> { self.backend.null() }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<B::Value, Error> { value.serialize(self) }
    fn serialize_unit(self) -> Result<B::Value, Error> { self.backend.null() }
    fn serialize_unit_struct(self, _: &'static str) -> Result<B::Value, Error> { self.backend.null() }
    fn serialize_unit_variant(self, _: &'static str, _: u32, _: &'static str) -> Result<B::Value, Error> { Err(Error("use an internally tagged contract enum".into())) }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _: &'static str, value: &T) -> Result<B::Value, Error> { value.serialize(self) }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(self, _: &'static str, _: u32, _: &'static str, _: &T) -> Result<B::Value, Error> { Err(Error("use an internally tagged contract enum".into())) }
    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        let value = self.backend.array()?;
        Ok(Compound { encoder: self, value, index: 0, key: None })
    }
    fn serialize_tuple(self, length: usize) -> Result<Self::SerializeTuple, Error> { self.serialize_seq(Some(length)) }
    fn serialize_tuple_struct(self, _: &'static str, length: usize) -> Result<Self::SerializeTupleStruct, Error> { self.serialize_seq(Some(length)) }
    fn serialize_tuple_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeTupleVariant, Error> { Err(Error("use an internally tagged contract enum".into())) }
    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Error> {
        if self.depth >= 128 { return Err(Error("structured value exceeds depth 128".into())); }
        let value = self.backend.object()?;
        Ok(Compound { encoder: self, value, index: 0, key: None })
    }
    fn serialize_struct(self, _: &'static str, length: usize) -> Result<Self::SerializeStruct, Error> { self.serialize_map(Some(length)) }
    fn serialize_struct_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeStructVariant, Error> { Err(Error("use an internally tagged contract enum".into())) }
}
struct Compound<'a, B: Writer> { encoder: Encoder<'a, B>, value: B::Value, index: usize, key: Option<String> }
impl<B: Writer> Compound<'_, B> {
    fn push<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        let encoded = value.serialize(self.encoder.child()?)?;
        self.encoder.backend.push(&self.value, self.index, encoded)?;
        self.index += 1;
        Ok(())
    }
    fn put<T: Serialize + ?Sized>(&mut self, key: &str, value: &T) -> Result<(), Error> {
        let encoded = value.serialize(self.encoder.child()?)?;
        self.encoder.backend.put(&self.value, key, encoded)
    }
}
impl<B: Writer> ser::SerializeSeq for Compound<'_, B> {
    type Ok = B::Value; type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { self.push(value) }
    fn end(self) -> Result<B::Value, Error> { Ok(self.value) }
}
impl<B: Writer> ser::SerializeTuple for Compound<'_, B> {
    type Ok = B::Value; type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { self.push(value) }
    fn end(self) -> Result<B::Value, Error> { Ok(self.value) }
}
impl<B: Writer> ser::SerializeTupleStruct for Compound<'_, B> {
    type Ok = B::Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> { self.push(value) }
    fn end(self) -> Result<B::Value, Error> { Ok(self.value) }
}
impl<B: Writer> ser::SerializeStruct for Compound<'_, B> {
    type Ok = B::Value; type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> Result<(), Error> { self.put(key, value) }
    fn end(self) -> Result<B::Value, Error> { Ok(self.value) }
}
impl<B: Writer> ser::SerializeMap for Compound<'_, B> {
    type Ok = B::Value; type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Error> {
        let value = key.serialize(self.encoder.child()?)?;
        if self.encoder.backend.kind(&value)? != Kind::String { return Err(Error("object keys must be strings".into())); }
        self.key = Some(self.encoder.backend.string(&value)?);
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        let key = self.key.take().ok_or_else(|| Error("map value without key".into()))?;
        self.put(&key, value)
    }
    fn serialize_entry<K: Serialize + ?Sized, V: Serialize + ?Sized>(&mut self, key: &K, value: &V) -> Result<(), Error> { self.serialize_key(key)?; self.serialize_value(value) }
    fn end(self) -> Result<B::Value, Error> { Ok(self.value) }
}
