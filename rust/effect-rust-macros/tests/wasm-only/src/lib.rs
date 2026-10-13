#![deny(warnings)]

pub struct Counter(u32);

#[effect_rust::resource]
impl Counter {
    pub fn new(value: u32) -> Self {
        Self(value)
    }

    pub fn value(&self) -> u32 {
        self.0
    }
}

#[effect_rust::export]
pub fn identity(value: u32) -> u32 {
    value
}
