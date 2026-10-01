// napi-derive owns the narrow generated FFI boundary; handwritten code is safe.
#[cfg(panic = "abort")]
compile_error!("The Node-API adapter requires panic=unwind for boundary reclamation");

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(js_name = "sha256Hex", catch_unwind)]
#[must_use]
pub fn sha256_hex(input: Buffer) -> String {
    hash_core::sha256_hex(&input)
}

#[napi(catch_unwind)]
#[must_use]
pub fn add(left: i32, right: i32) -> i32 {
    math_core::add(left, right)
}
