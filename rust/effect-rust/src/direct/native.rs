//! The only raw-handle boundary: checked casts and creation of call-local napi handles.
use super::{Error, Kind, Reader, Writer};
use napi::{
    bindgen_prelude::{BigInt, FromNapiValue, JsObjectValue, Object, ToNapiValue},
    Env, JsValue, KeyCollectionMode, KeyConversion, KeyFilter, Unknown, ValueType,
};
use std::marker::PhantomData;

pub struct Native<'env> {
    env: Env,
    lifetime: PhantomData<&'env ()>,
}
fn error(error: napi::Error) -> Error {
    Error(error.to_string())
}
impl<'env> Native<'env> {
    fn read<T: FromNapiValue>(
        &self,
        value: &Unknown<'env>,
        expected: ValueType,
    ) -> Result<T, Error> {
        if value.get_type().map_err(error)? != expected {
            return Err(Error(format!("expected {expected:?}")));
        }
        // SAFETY: napi checked the runtime value type above. T is selected only
        // by the private, matching scalar/Object callers below; the value and env
        // both belong to the current adapter call, and never cross threads.
        #[allow(unsafe_code)]
        unsafe {
            value.cast().map_err(error)
        }
    }
    fn value<T: ToNapiValue>(&self, value: T) -> Result<Unknown<'env>, Error> {
        // SAFETY: Env is injected by napi into the active adapter call. The napi
        // conversion produces a handle in that env; the returned lifetime is the
        // current call's lifetime, never a persistent reference or Send handle.
        #[allow(unsafe_code)]
        unsafe {
            let raw = T::to_napi_value(self.env.raw(), value).map_err(error)?;
            Ok(Unknown::from_raw_unchecked(self.env.raw(), raw))
        }
    }
}
impl<'env> Reader for Native<'env> {
    type Value = Unknown<'env>;
    fn kind(&self, value: &Unknown<'env>) -> Result<Kind, Error> {
        Ok(match value.get_type().map_err(error)? {
            ValueType::Null => Kind::Null,
            ValueType::Boolean => Kind::Bool,
            ValueType::Number => Kind::Number,
            ValueType::BigInt => Kind::BigInt,
            ValueType::String => Kind::String,
            ValueType::Object => {
                let object: Object = self.read(value, ValueType::Object)?;
                if object.is_array().map_err(error)? {
                    Kind::Array
                } else {
                    Kind::Object
                }
            }
            _ => Kind::Unsupported,
        })
    }
    fn boolean(&self, value: &Unknown<'env>) -> Result<bool, Error> {
        self.read(value, ValueType::Boolean)
    }
    fn number(&self, value: &Unknown<'env>) -> Result<f64, Error> {
        self.read(value, ValueType::Number)
    }
    fn string(&self, value: &Unknown<'env>) -> Result<String, Error> {
        let text: String = self.read(value, ValueType::String)?;
        if text.contains('\u{fffd}') {
            let string: napi::JsString = self.read(value, ValueType::String)?;
            let units = string.into_utf16().map_err(error)?;
            if char::decode_utf16(units.iter().copied()).any(|character| character.is_err()) {
                return Err(Error("unpaired Unicode surrogate".into()));
            }
        }
        Ok(text)
    }
    fn unsigned(&self, value: &Unknown<'env>) -> Result<u64, Error> {
        let bigint: BigInt = self.read(value, ValueType::BigInt)?;
        let (negative, value, lossless) = bigint.get_u64();
        if negative || !lossless {
            return Err(Error("bigint outside u64 range".into()));
        }
        Ok(value)
    }
    fn signed(&self, value: &Unknown<'env>) -> Result<i64, Error> {
        let bigint: BigInt = self.read(value, ValueType::BigInt)?;
        let (value, lossless) = bigint.get_i64();
        if !lossless {
            return Err(Error("bigint outside i64 range".into()));
        }
        Ok(value)
    }
    fn keys(&self, value: &Unknown<'env>) -> Result<Vec<String>, Error> {
        let object: Object = self.read(value, ValueType::Object)?;
        let keys = object
            .get_all_property_names(
                KeyCollectionMode::OwnOnly,
                KeyFilter::Enumerable,
                KeyConversion::NumbersToStrings,
            )
            .map_err(error)?;
        let length = keys.get_array_length().map_err(error)?;
        let mut output = Vec::with_capacity(length as usize);
        for index in 0..length {
            let key: Unknown = keys.get_element(index).map_err(error)?;
            if key.get_type().map_err(error)? == ValueType::String {
                output.push(self.string(&key)?);
            }
        }
        Ok(output)
    }
    fn get(&self, value: &Unknown<'env>, key: &str) -> Result<Unknown<'env>, Error> {
        let object: Object = self.read(value, ValueType::Object)?;
        object
            .get_property(self.env.create_string(key).map_err(error)?)
            .map_err(error)
    }
    fn length(&self, value: &Unknown<'env>) -> Result<usize, Error> {
        let object: Object = self.read(value, ValueType::Object)?;
        Ok(object.get_array_length().map_err(error)? as usize)
    }
    fn element(&self, value: &Unknown<'env>, index: usize) -> Result<Unknown<'env>, Error> {
        let object: Object = self.read(value, ValueType::Object)?;
        object
            .get_element(u32::try_from(index).map_err(|_| Error("array index overflow".into()))?)
            .map_err(error)
    }
}
impl<'env> Writer for Native<'env> {
    fn null(&self) -> Result<Unknown<'env>, Error> {
        self.value(napi::bindgen_prelude::Null)
    }
    fn bool_value(&self, value: bool) -> Result<Unknown<'env>, Error> {
        self.value(value)
    }
    fn number_value(&self, value: f64) -> Result<Unknown<'env>, Error> {
        self.value(value)
    }
    fn string_value(&self, value: &str) -> Result<Unknown<'env>, Error> {
        self.value(value)
    }
    fn unsigned_value(&self, value: u64) -> Result<Unknown<'env>, Error> {
        self.value(BigInt::from(value))
    }
    fn signed_value(&self, value: i64) -> Result<Unknown<'env>, Error> {
        self.value(BigInt::from(value))
    }
    fn object(&self) -> Result<Unknown<'env>, Error> {
        self.value(Object::new(&self.env).map_err(error)?)
    }
    fn array(&self) -> Result<Unknown<'env>, Error> {
        self.value(Vec::<bool>::new())
    }
    fn put(&self, object: &Unknown<'env>, key: &str, value: Unknown<'env>) -> Result<(), Error> {
        let mut object: Object = self.read(object, ValueType::Object)?;
        if key == "__proto__" {
            // A record key is data, never the inherited prototype setter.
            let property = napi::Property::new()
                .with_utf8_name(key)
                .map_err(error)?
                .with_value(&value);
            object.define_properties(&[property]).map_err(error)
        } else {
            object
                .set_property(self.env.create_string(key).map_err(error)?, value)
                .map_err(error)
        }
    }
    fn push(&self, array: &Unknown<'env>, index: usize, value: Unknown<'env>) -> Result<(), Error> {
        let mut array: Object = self.read(array, ValueType::Object)?;
        array
            .set_element(
                u32::try_from(index).map_err(|_| Error("array index overflow".into()))?,
                value,
            )
            .map_err(error)
    }
}
pub fn decode<T: serde::de::DeserializeOwned>(env: Env, value: Unknown<'_>) -> Result<T, Error> {
    super::decode(
        &Native {
            env,
            lifetime: PhantomData,
        },
        value,
    )
}
pub fn encode<'env, T: serde::Serialize + ?Sized>(
    env: Env,
    value: &T,
) -> Result<Unknown<'env>, Error> {
    super::encode(
        &Native {
            env,
            lifetime: PhantomData,
        },
        value,
    )
}
pub fn encode_error<'env, T: serde::Serialize + ?Sized>(
    env: Env,
    value: &T,
) -> Result<Unknown<'env>, Error> {
    super::encode_error(
        &Native {
            env,
            lifetime: PhantomData,
        },
        value,
    )
}

/// Cross-thread callback data owns Rust strings, not napi handles.
pub struct HostRequest(pub crate::host::Request<String>);
impl ToNapiValue for HostRequest {
    // SAFETY: napi invokes this conversion on the owning JS thread with its
    // active env; encoding and handle extraction happen entirely in that call.
    #[allow(unsafe_code)]
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        value: Self,
    ) -> napi::Result<napi::sys::napi_value> {
        use napi::JsValue as _;
        let env = Env::from_raw(env);
        let value =
            encode(env, &value.0).map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(value.raw())
    }
}
