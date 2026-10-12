// Exact numeric semantics shared by schema admission and emitted runtime validation.
// serde_json's ordinary Number representation has at most 20 integer digits or
// 17 significant float digits. Keep numeric validation exact and allocation-free.
#[derive(Clone, Copy)]
struct SchemaDecimal {
    negative: bool,
    coefficient: u128,
    scale: i32,
}
impl SchemaDecimal {
    fn parse(value: &str) -> Self {
        let negative = value.starts_with('-');
        let value = value.strip_prefix('-').unwrap_or(value);
        let (mantissa, exponent) = value
            .split_once(['e', 'E'])
            .map_or((value, 0), |(mantissa, exponent)| {
                (mantissa, exponent.parse::<i32>().expect("JSON exponent"))
            });
        let fraction = mantissa.split_once('.').map_or(0, |(_, fraction)| {
            i32::try_from(fraction.len()).expect("JSON significand length")
        });
        let coefficient = mantissa
            .bytes()
            .filter(|c| *c != b'.')
            .fold(0_u128, |value, digit| value * 10 + u128::from(digit - b'0'));
        Self {
            negative: negative && coefficient != 0,
            coefficient,
            scale: exponent - fraction,
        }
    }
    fn number(value: &serde_json::Number) -> Self {
        if let Some(integer) = value.as_i64() {
            return Self {
                negative: integer < 0,
                coefficient: u128::from(integer.unsigned_abs()),
                scale: 0,
            };
        }
        if let Some(integer) = value.as_u64() {
            return Self {
                negative: false,
                coefficient: u128::from(integer),
                scale: 0,
            };
        }
        struct Buffer {
            bytes: [u8; 64],
            length: usize,
        }
        impl std::fmt::Write for Buffer {
            fn write_str(&mut self, value: &str) -> std::fmt::Result {
                let end = self.length + value.len();
                self.bytes
                    .get_mut(self.length..end)
                    .ok_or(std::fmt::Error)?
                    .copy_from_slice(value.as_bytes());
                self.length = end;
                Ok(())
            }
        }
        let mut buffer = Buffer {
            bytes: [0; 64],
            length: 0,
        };
        std::fmt::write(&mut buffer, format_args!("{value}"))
            .expect("finite JSON Number fits 64 bytes");
        Self::parse(
            std::str::from_utf8(&buffer.bytes[..buffer.length]).expect("JSON Number is ASCII"),
        )
    }
    fn compare(self, other: Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if self.coefficient == 0 || other.coefficient == 0 {
            return match (self.coefficient == 0, other.coefficient == 0) {
                (true, true) => Ordering::Equal,
                (true, false) => {
                    if other.negative {
                        Ordering::Greater
                    } else {
                        Ordering::Less
                    }
                }
                (false, true) => {
                    if self.negative {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    }
                }
                (false, false) => unreachable!(),
            };
        }
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let left_digits = self.coefficient.ilog10() + 1;
        let right_digits = other.coefficient.ilog10() + 1;
        let magnitude = (i64::from(left_digits) + i64::from(self.scale))
            .cmp(&(i64::from(right_digits) + i64::from(other.scale)));
        let ordering = if magnitude == Ordering::Equal {
            let digits = left_digits.max(right_digits);
            (self.coefficient * 10_u128.pow(digits - left_digits))
                .cmp(&(other.coefficient * 10_u128.pow(digits - right_digits)))
        } else {
            magnitude
        };
        if self.negative {
            ordering.reverse()
        } else {
            ordering
        }
    }
}
/// Compare a Number with a canonical, finite JSON Schema numeric bound.
#[must_use]
pub fn compare_number(value: &serde_json::Number, bound: &str) -> std::cmp::Ordering {
    SchemaDecimal::number(value).compare(SchemaDecimal::parse(bound))
}
#[must_use]
pub fn numbers_equal(left: &serde_json::Number, right: &serde_json::Number) -> bool {
    SchemaDecimal::number(left).compare(SchemaDecimal::number(right)) == std::cmp::Ordering::Equal
}
#[must_use]
pub fn is_integer(value: &serde_json::Number) -> bool {
    let decimal = SchemaDecimal::number(value);
    if decimal.coefficient == 0 || decimal.scale >= 0 {
        return true;
    }
    let mut coefficient = decimal.coefficient;
    let mut zeros = 0;
    while coefficient % 10 == 0 {
        coefficient /= 10;
        zeros += 1;
    }
    zeros >= -decimal.scale
}
/// Check an exact decimal multiple against a positive canonical JSON Schema divisor.
#[must_use]
pub fn is_multiple_of(value: &serde_json::Number, divisor: &str) -> bool {
    let numerator_value = SchemaDecimal::number(value);
    let denominator_value = SchemaDecimal::parse(divisor);
    let (mut numerator, numerator_scale) = (numerator_value.coefficient, numerator_value.scale);
    let (mut denominator, denominator_scale) =
        (denominator_value.coefficient, denominator_value.scale);
    if numerator == 0 {
        return true;
    }
    let (mut a, mut b) = (numerator, denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    numerator /= a;
    denominator /= a;
    let scale = numerator_scale - denominator_scale;
    if scale >= 0 {
        for prime in [2, 5] {
            let mut powers = 0;
            while denominator % prime == 0 {
                denominator /= prime;
                powers += 1;
            }
            if powers > scale {
                return false;
            }
        }
        denominator == 1
    } else {
        if denominator != 1 {
            return false;
        }
        let mut zeros = 0;
        while numerator % 10 == 0 {
            numerator /= 10;
            zeros += 1;
        }
        zeros >= -scale
    }
}
