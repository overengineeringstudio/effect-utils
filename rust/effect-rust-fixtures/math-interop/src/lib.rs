pub mod contract;

use contract::{Discount, Order, Quote};

#[derive(Debug, serde::Serialize, serde::Deserialize, effect_rust::ExportError)]
#[serde(tag = "reason", deny_unknown_fields)]
pub enum ArithmeticError {
    DivideByZero { dividend: i32 },
    Overflow { dividend: i32, divisor: i32 },
    InvalidChunkSize { chunk: u32 },
    PriceOverflow { quantity: u32 },
}

impl std::fmt::Display for ArithmeticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DivideByZero { dividend } => write!(f, "cannot divide {dividend} by zero"),
            Self::Overflow { dividend, divisor } => write!(f, "{dividend}/{divisor} overflows i32"),
            Self::InvalidChunkSize { chunk } => write!(f, "chunk size must be 1..=1048576, got {chunk}"),
            Self::PriceOverflow { quantity } => write!(f, "order total overflows u64 at quantity {quantity}"),
        }
    }
}
impl std::error::Error for ArithmeticError {}

#[effect_rust::export]
pub fn add(left: i32, right: i32) -> i32 {
    math_core::add(left, right)
}

#[effect_rust::export(name = "checkedDivide", error_tag = "reason")]
pub fn checked_divide(dividend: i32, divisor: i32) -> Result<i32, ArithmeticError> {
    if divisor == 0 {
        return Err(ArithmeticError::DivideByZero { dividend });
    }
    dividend.checked_div(divisor).ok_or(ArithmeticError::Overflow { dividend, divisor })
}

/// Serde domain types cross the edge through the Rust-owned contract schemas.
#[effect_rust::export(name = "quoteOrder", error_tag = "reason")]
pub fn quote_order(order: Order, discount: Discount) -> Result<Quote, ArithmeticError> {
    let quantity = order.quantity;
    contract::quote(order, &discount).ok_or(ArithmeticError::PriceOverflow { quantity })
}

pub struct Chunks {
    remaining: u32,
    chunk: u32,
    offset: u32,
}

impl Iterator for Chunks {
    type Item = Vec<u8>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        let length = self.remaining.min(self.chunk);
        let bytes = (0..length).map(|index| (self.offset.wrapping_add(index) % 256) as u8).collect();
        self.remaining -= length;
        self.offset = self.offset.wrapping_add(length);
        Some(bytes)
    }
}

#[effect_rust::export(output_stream, error_tag = "reason")]
pub fn chunks(total: u32, chunk: u32) -> Result<Chunks, ArithmeticError> {
    if !(1..=1_048_576).contains(&chunk) {
        return Err(ArithmeticError::InvalidChunkSize { chunk });
    }
    Ok(Chunks { remaining: total, chunk, offset: 0 })
}

#[derive(borsh::BorshSerialize, borsh::BorshDeserialize)]
// Explicit namespace keeps derive independent of Cargo's filesystem during Buck actions.
#[borsh(crate = "borsh")]
pub struct Sample {
    pub value: u32,
}

#[effect_rust::export(frame, name = "sumRows", contract_id = 4026459905, version = 1)]
pub fn sum_rows(rows: &[Sample]) -> u64 {
    rows.iter().map(|sample| u64::from(sample.value)).sum()
}

#[effect_rust::export(name = "panicTest")]
pub fn panic_test() -> i32 {
    panic!("fixture panic boundary")
}
