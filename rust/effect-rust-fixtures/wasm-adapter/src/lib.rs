#![forbid(unsafe_code)]

use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen(js_name = sha256Hex)]
#[must_use]
pub fn sha256_hex(input: &[u8]) -> String {
    hash_core::sha256_hex(input)
}

#[wasm_bindgen]
#[must_use]
pub fn add(left: i32, right: i32) -> i32 {
    math_core::add(left, right)
}
