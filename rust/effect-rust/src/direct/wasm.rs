//! wasm handles stay in the calling isolate and never survive an adapter entry.
use super::{Reader, Writer, Error, Kind};
use wasm_bindgen::{JsCast, JsValue};

pub struct Wasm;
fn error(value: JsValue) -> Error { Error(format!("JavaScript property access failed: {value:?}")) }
impl Reader for Wasm {
    type Value = JsValue;
    fn kind(&self, value: &JsValue) -> Result<Kind, Error> {
        Ok(if value.is_null() { Kind::Null } else if value.as_bool().is_some() { Kind::Bool }
        else if value.as_f64().is_some() { Kind::Number } else if value.is_bigint() { Kind::BigInt }
        else if value.is_string() { Kind::String } else if js_sys::Array::is_array(value) { Kind::Array }
        else if value.is_object() && !value.is_function() { Kind::Object } else { Kind::Unsupported })
    }
    fn boolean(&self, value: &JsValue) -> Result<bool, Error> { value.as_bool().ok_or_else(|| Error("expected boolean".into())) }
    fn number(&self, value: &JsValue) -> Result<f64, Error> { value.as_f64().ok_or_else(|| Error("expected number".into())) }
    fn string(&self, value: &JsValue) -> Result<String, Error> {
        let text = value.as_string().ok_or_else(|| Error("expected string".into()))?;
        if text.contains('\u{fffd}') && !value.unchecked_ref::<js_sys::JsString>().is_valid_utf16() {
            return Err(Error("unpaired Unicode surrogate".into()));
        }
        Ok(text)
    }
    fn unsigned(&self, value: &JsValue) -> Result<u64, Error> { u64::try_from(value.clone()).map_err(|_| Error("bigint outside u64 range".into())) }
    fn signed(&self, value: &JsValue) -> Result<i64, Error> { i64::try_from(value.clone()).map_err(|_| Error("bigint outside i64 range".into())) }
    fn keys(&self, value: &JsValue) -> Result<Vec<String>, Error> {
        js_sys::Object::keys(value.unchecked_ref()).iter().map(|key| self.string(&key)).collect()
    }
    fn get(&self, value: &JsValue, key: &str) -> Result<JsValue, Error> { js_sys::Reflect::get(value, &JsValue::from_str(key)).map_err(error) }
    fn length(&self, value: &JsValue) -> Result<usize, Error> { Ok(value.unchecked_ref::<js_sys::Array>().length() as usize) }
    fn element(&self, value: &JsValue, index: usize) -> Result<JsValue, Error> {
        let index = u32::try_from(index).map_err(|_| Error("array index overflow".into()))?;
        Ok(value.unchecked_ref::<js_sys::Array>().get(index))
    }
}
impl Writer for Wasm {
    fn null(&self) -> Result<JsValue, Error> { Ok(JsValue::NULL) }
    fn bool_value(&self, value: bool) -> Result<JsValue, Error> { Ok(JsValue::from_bool(value)) }
    fn number_value(&self, value: f64) -> Result<JsValue, Error> { Ok(JsValue::from_f64(value)) }
    fn string_value(&self, value: &str) -> Result<JsValue, Error> { Ok(JsValue::from_str(value)) }
    fn unsigned_value(&self, value: u64) -> Result<JsValue, Error> { Ok(JsValue::from(value)) }
    fn signed_value(&self, value: i64) -> Result<JsValue, Error> { Ok(JsValue::from(value)) }
    fn object(&self) -> Result<JsValue, Error> { Ok(js_sys::Object::new().into()) }
    fn array(&self) -> Result<JsValue, Error> { Ok(js_sys::Array::new().into()) }
    fn put(&self, object: &JsValue, key: &str, value: JsValue) -> Result<(), Error> {
        if key == "__proto__" {
            // A record key is data, never the inherited prototype setter.
            let descriptor = js_sys::Object::new();
            js_sys::Reflect::set(&descriptor, &JsValue::from_str("value"), &value).map_err(error)?;
            for name in ["enumerable", "writable", "configurable"] { js_sys::Reflect::set(&descriptor, &JsValue::from_str(name), &JsValue::TRUE).map_err(error)?; }
            js_sys::Reflect::define_property(object.unchecked_ref(), &JsValue::from_str(key), &descriptor).map_err(error)?;
        } else {
            js_sys::Reflect::set(object, &JsValue::from_str(key), &value).map_err(error)?;
        }
        Ok(())
    }
    fn push(&self, array: &JsValue, index: usize, value: JsValue) -> Result<(), Error> {
        array.unchecked_ref::<js_sys::Array>().set(u32::try_from(index).map_err(|_| Error("array index overflow".into()))?, value);
        Ok(())
    }
}
pub fn decode<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, Error> { super::decode(&Wasm, value) }
pub fn encode<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, Error> { super::encode(&Wasm, value) }
pub fn encode_error<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, Error> { super::encode_error(&Wasm, value) }
