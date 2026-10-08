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
            Self::InvalidChunkSize { chunk } => {
                write!(f, "chunk size must be 1..=1048576, got {chunk}")
            }
            Self::PriceOverflow { quantity } => {
                write!(f, "order total overflows u64 at quantity {quantity}")
            }
        }
    }
}
impl std::error::Error for ArithmeticError {}

#[effect_rust::export]
pub fn add(left: i32, right: i32) -> i32 {
    math_core::add(left, right)
}

#[effect_rust::export(name = "echoF32")]
pub fn echo_f32(value: f32) -> f32 {
    value
}

#[effect_rust::export(name = "echoI8")]
pub fn echo_i8(value: i8) -> i8 {
    value
}

#[effect_rust::export(name = "echoU8")]
pub fn echo_u8(value: u8) -> u8 {
    value
}

#[effect_rust::export(name = "echoI16")]
pub fn echo_i16(value: i16) -> i16 {
    value
}

#[effect_rust::export(name = "echoU16")]
pub fn echo_u16(value: u16) -> u16 {
    value
}

#[effect_rust::export(name = "echoI32")]
pub fn echo_i32(value: i32) -> i32 {
    value
}

#[effect_rust::export(name = "echoU32")]
pub fn echo_u32(value: u32) -> u32 {
    value
}

static LIVE_JOBS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

struct LiveJob;
impl LiveJob {
    fn new() -> Self {
        LIVE_JOBS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self
    }
}
impl Drop for LiveJob {
    fn drop(&mut self) {
        LIVE_JOBS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[effect_rust::export(name = "liveJobs")]
pub fn live_jobs() -> u32 {
    LIVE_JOBS.load(std::sync::atomic::Ordering::SeqCst)
}

#[effect_rust::export(async, name = "pendingJob")]
pub async fn pending_job() -> u32 {
    let _live = LiveJob::new();
    std::future::pending().await
}

#[effect_rust::export(async, name = "settleJob")]
pub async fn settle_job(
    source: effect_rust::host::Source<effect_rust::host::SettleOnly>,
) -> effect_rust::Bytes {
    let _live = LiveJob::new();
    source
        .read("/settle")
        .await
        .expect("fixture host read succeeds")
}

#[effect_rust::export(name = "checkedDivide", error_tag = "reason")]
pub fn checked_divide(dividend: i32, divisor: i32) -> Result<i32, ArithmeticError> {
    if divisor == 0 {
        return Err(ArithmeticError::DivideByZero { dividend });
    }
    dividend
        .checked_div(divisor)
        .ok_or(ArithmeticError::Overflow { dividend, divisor })
}

/// Serde domain types cross the edge through the Rust-owned contract schemas.
#[effect_rust::export(name = "quoteOrder", error_tag = "reason")]
pub fn quote_order(order: Order, discount: Discount) -> Result<Quote, ArithmeticError> {
    let quantity = order.quantity;
    contract::quote(order, &discount).ok_or(ArithmeticError::PriceOverflow { quantity })
}

#[effect_rust::export(name = "sumJsonIntegers")]
pub fn sum_json_integers(input: contract::NumericOperands) -> i64 {
    i64::from(input.unsigned)
        + i64::from(input.signed)
        + i64::try_from(input.bounded).expect("validated safe integer")
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
        let bytes = (0..length)
            .map(|index| (self.offset.wrapping_add(index) % 256) as u8)
            .collect();
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
    Ok(Chunks {
        remaining: total,
        chunk,
        offset: 0,
    })
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

#[effect_rust::export(async, name = "panicFirstPoll")]
pub async fn panic_first_poll() -> u32 {
    panic!("fixture panic on first asynchronous poll")
}

#[effect_rust::export(async, name = "panicAfterHostAwait")]
pub async fn panic_after_host_await(
    source: effect_rust::host::Source<effect_rust::host::SettleOnly>,
) -> u32 {
    source
        .read("/panic")
        .await
        .expect("fixture host read succeeds before panic");
    panic!("fixture panic after host await")
}

static COUNTER_DROPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub struct Counter {
    value: i32,
}

#[effect_rust::resource]
impl Counter {
    pub fn new(value: i32) -> Self {
        Self { value }
    }

    pub fn append(&mut self, digit: i32) -> i32 {
        self.value = self.value * 10 + digit;
        self.value
    }

    pub fn value(&self) -> i32 {
        self.value
    }

    pub fn divide(&mut self, divisor: i32) -> Result<i32, ArithmeticError> {
        let value = checked_divide(self.value, divisor)?;
        self.value = value;
        Ok(value)
    }

    pub fn panic(&mut self) -> i32 {
        panic!("fixture resource panic boundary")
    }
}

impl Drop for Counter {
    fn drop(&mut self) {
        COUNTER_DROPS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[effect_rust::export(name = "counterDrops")]
pub fn counter_drops() -> u32 {
    COUNTER_DROPS.load(std::sync::atomic::Ordering::SeqCst)
}
