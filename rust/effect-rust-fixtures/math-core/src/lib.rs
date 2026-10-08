#![forbid(unsafe_code)]

/// Saturating addition keeps overflow behavior identical across build profiles.
#[must_use]
pub const fn add(left: i32, right: i32) -> i32 {
    left.saturating_add(right)
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn addition_saturates_at_both_boundaries() {
        assert_eq!(add(20, 22), 42);
        assert_eq!(add(i32::MAX, 1), i32::MAX);
        assert_eq!(add(i32::MIN, -1), i32::MIN);
    }
}
