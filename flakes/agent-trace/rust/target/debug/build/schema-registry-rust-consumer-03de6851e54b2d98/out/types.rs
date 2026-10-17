// Generated test consumer; schemas above are the semantic inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error { Invalid(String) }
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Invalid(message) => f.write_str(message) }
    }
}
impl std::error::Error for Error {}
/// Preserve omitted-vs-present semantics, including nullable values when the schema permits them.
///
/// # Errors
/// Propagates the inner schema type's deserialization error.
pub fn deserialize_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}
#[must_use]
pub fn utf16_len(value: &str) -> usize { value.encode_utf16().count() }
#[must_use]
pub fn is_js_trimmed(value: &str) -> bool {
    fn whitespace(c: char) -> bool {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }
    value.chars().next().is_none_or(|c| !whitespace(c))
        && value.chars().next_back().is_none_or(|c| !whitespace(c))
}

// Exact numeric semantics shared by schema admission and emitted runtime validation.
// serde_json's ordinary Number representation has at most 20 integer digits or
// 17 significant float digits. Keep numeric validation exact and allocation-free.
#[derive(Clone, Copy)]
struct SchemaDecimal { negative: bool, coefficient: u128, scale: i32 }
impl SchemaDecimal {
    fn parse(value: &str) -> Self {
        let negative = value.starts_with('-');
        let value = value.strip_prefix('-').unwrap_or(value);
        let (mantissa, exponent) = value.split_once(['e', 'E']).map_or((value, 0), |(mantissa, exponent)| (mantissa, exponent.parse::<i32>().expect("JSON exponent")));
        let fraction = mantissa.split_once('.').map_or(0, |(_, fraction)| i32::try_from(fraction.len()).expect("JSON significand length"));
        let coefficient = mantissa.bytes().filter(|c| *c != b'.').fold(0_u128, |value, digit| value * 10 + u128::from(digit - b'0'));
        Self { negative: negative && coefficient != 0, coefficient, scale: exponent - fraction }
    }
    fn number(value: &serde_json::Number) -> Self {
        if let Some(integer) = value.as_i64() {
            return Self { negative: integer < 0, coefficient: u128::from(integer.unsigned_abs()), scale: 0 };
        }
        if let Some(integer) = value.as_u64() {
            return Self { negative: false, coefficient: u128::from(integer), scale: 0 };
        }
        struct Buffer { bytes: [u8; 64], length: usize }
        impl std::fmt::Write for Buffer {
            fn write_str(&mut self, value: &str) -> std::fmt::Result {
                let end = self.length + value.len();
                self.bytes.get_mut(self.length..end).ok_or(std::fmt::Error)?.copy_from_slice(value.as_bytes());
                self.length = end;
                Ok(())
            }
        }
        let mut buffer = Buffer { bytes: [0; 64], length: 0 };
        std::fmt::write(&mut buffer, format_args!("{value}")).expect("finite JSON Number fits 64 bytes");
        Self::parse(std::str::from_utf8(&buffer.bytes[..buffer.length]).expect("JSON Number is ASCII"))
    }
    fn compare(self, other: Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if self.coefficient == 0 || other.coefficient == 0 {
            return match (self.coefficient == 0, other.coefficient == 0) {
                (true, true) => Ordering::Equal,
                (true, false) => if other.negative { Ordering::Greater } else { Ordering::Less },
                (false, true) => if self.negative { Ordering::Less } else { Ordering::Greater },
                (false, false) => unreachable!(),
            };
        }
        if self.negative != other.negative { return if self.negative { Ordering::Less } else { Ordering::Greater }; }
        let left_digits = self.coefficient.ilog10() + 1;
        let right_digits = other.coefficient.ilog10() + 1;
        let magnitude = (i64::from(left_digits) + i64::from(self.scale)).cmp(&(i64::from(right_digits) + i64::from(other.scale)));
        let ordering = if magnitude == Ordering::Equal {
            let digits = left_digits.max(right_digits);
            (self.coefficient * 10_u128.pow(digits - left_digits)).cmp(&(other.coefficient * 10_u128.pow(digits - right_digits)))
        } else { magnitude };
        if self.negative { ordering.reverse() } else { ordering }
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
    if decimal.coefficient == 0 || decimal.scale >= 0 { return true; }
    let mut coefficient = decimal.coefficient;
    let mut zeros = 0;
    while coefficient % 10 == 0 { coefficient /= 10; zeros += 1; }
    zeros >= -decimal.scale
}
/// Check an exact decimal multiple against a positive canonical JSON Schema divisor.
#[must_use]
pub fn is_multiple_of(value: &serde_json::Number, divisor: &str) -> bool {
    let numerator_value = SchemaDecimal::number(value);
    let denominator_value = SchemaDecimal::parse(divisor);
    let (mut numerator, numerator_scale) = (numerator_value.coefficient, numerator_value.scale);
    let (mut denominator, denominator_scale) = (denominator_value.coefficient, denominator_value.scale);
    if numerator == 0 { return true; }
    let (mut a, mut b) = (numerator, denominator);
    while b != 0 { (a, b) = (b, a % b); }
    numerator /= a;
    denominator /= a;
    let scale = numerator_scale - denominator_scale;
    if scale >= 0 {
        for prime in [2, 5] {
            let mut powers = 0;
            while denominator % prime == 0 { denominator /= prime; powers += 1; }
            if powers > scale { return false; }
        }
        denominator == 1
    } else {
        if denominator != 1 { return false; }
        let mut zeros = 0;
        while numerator % 10 == 0 { numerator /= 10; zeros += 1; }
        zeros >= -scale
    }
}

pub mod types {
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct Integer(serde_json::Number);
impl Integer { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("Integer: integer".into())); }
if crate::compare_number(value, "-2").is_lt() { return Err(crate::Error::Invalid("Integer: minimum".into())); }
if crate::compare_number(value, "4").is_gt() { return Err(crate::Error::Invalid("Integer: maximum".into())); }
if !crate::is_multiple_of(value, "2") { return Err(crate::Error::Invalid("Integer: multipleOf".into())); }
Ok(()) } }
impl PartialEq for Integer { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for Integer { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for Integer { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct Number(serde_json::Number);
impl Number { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
let _ = value;
if !crate::compare_number(value, "0").is_gt() { return Err(crate::Error::Invalid("Number: exclusiveMinimum".into())); }
if !crate::compare_number(value, "1").is_lt() { return Err(crate::Error::Invalid("Number: exclusiveMaximum".into())); }
if !crate::is_multiple_of(value, "0.1") { return Err(crate::Error::Invalid("Number: multipleOf".into())); }
Ok(()) } }
impl PartialEq for Number { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for Number { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for Number { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct Flag(bool);
impl Flag { #[must_use] pub fn value(&self) -> &bool { &self.0 }
fn validate(value: &bool) -> Result<(), crate::Error> {
let _ = value;
if !(*value) { return Err(crate::Error::Invalid("Flag: const".into())); }
Ok(()) } }
impl TryFrom<bool> for Flag { type Error = crate::Error; fn try_from(value: bool) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for Flag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <bool as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct Text(String);
impl Text { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("Text: minLength".into())); }
if crate::utf16_len(value) > 2 { return Err(crate::Error::Invalid("Text: maxLength".into())); }
if !crate::is_js_trimmed(value) { return Err(crate::Error::Invalid("Text: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for Text { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for Text { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct ListItem(serde_json::Number);
impl ListItem { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("ListItem: integer".into())); }
if crate::compare_number(value, "0").is_lt() { return Err(crate::Error::Invalid("ListItem: minimum".into())); }
Ok(()) } }
impl PartialEq for ListItem { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for ListItem { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ListItem { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct List(Vec<ListItem>);
impl List { #[must_use] pub fn as_slice(&self) -> &[ListItem] { &self.0 }
fn validate(value: &[ListItem]) -> Result<(), crate::Error> { let _ = value;
if value.len() < 1 { return Err(crate::Error::Invalid("List: minItems".into())); }
if value.len() > 3 { return Err(crate::Error::Invalid("List: maxItems".into())); }
if value.iter().enumerate().any(|(index, item)| value[..index].contains(item)) { return Err(crate::Error::Invalid("List: uniqueItems".into())); }
Ok(()) } }
impl TryFrom<Vec<ListItem>> for List { type Error = crate::Error; fn try_from(value: Vec<ListItem>) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for List { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <Vec<ListItem> as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ChoiceVariant0Kind(String);
impl ChoiceVariant0Kind { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "ok" { return Err(crate::Error::Invalid("ChoiceVariant0Kind: const".into())); }
Ok(()) } }
impl TryFrom<String> for ChoiceVariant0Kind { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ChoiceVariant0Kind { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ChoiceVariant0ItemsItem(String);
impl ChoiceVariant0ItemsItem { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("ChoiceVariant0ItemsItem: minLength".into())); }
Ok(()) } }
impl TryFrom<String> for ChoiceVariant0ItemsItem { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ChoiceVariant0ItemsItem { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ChoiceVariant0Items(Vec<ChoiceVariant0ItemsItem>);
impl ChoiceVariant0Items { #[must_use] pub fn as_slice(&self) -> &[ChoiceVariant0ItemsItem] { &self.0 }
fn validate(value: &[ChoiceVariant0ItemsItem]) -> Result<(), crate::Error> { let _ = value;
Ok(()) } }
impl TryFrom<Vec<ChoiceVariant0ItemsItem>> for ChoiceVariant0Items { type Error = crate::Error; fn try_from(value: Vec<ChoiceVariant0ItemsItem>) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ChoiceVariant0Items { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <Vec<ChoiceVariant0ItemsItem> as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChoiceVariant0 {
pub r#kind: ChoiceVariant0Kind,
pub r#items: ChoiceVariant0Items,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ChoiceVariant1Kind(String);
impl ChoiceVariant1Kind { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "error" { return Err(crate::Error::Invalid("ChoiceVariant1Kind: const".into())); }
Ok(()) } }
impl TryFrom<String> for ChoiceVariant1Kind { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ChoiceVariant1Kind { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ChoiceVariant1Message(String);
impl ChoiceVariant1Message { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("ChoiceVariant1Message: minLength".into())); }
Ok(()) } }
impl TryFrom<String> for ChoiceVariant1Message { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ChoiceVariant1Message { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChoiceVariant1 {
pub r#kind: ChoiceVariant1Kind,
pub r#message: ChoiceVariant1Message,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum Choice {
Variant0(ChoiceVariant0),
Variant1(ChoiceVariant1),
}
impl<'de> serde::Deserialize<'de> for Choice { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <ChoiceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <ChoiceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("Choice: no union branch matched")) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct ReferencedCountsItem(serde_json::Number);
impl ReferencedCountsItem { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("ReferencedCountsItem: integer".into())); }
if crate::compare_number(value, "1").is_lt() { return Err(crate::Error::Invalid("ReferencedCountsItem: minimum".into())); }
Ok(()) } }
impl PartialEq for ReferencedCountsItem { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for ReferencedCountsItem { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ReferencedCountsItem { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ReferencedCounts(Vec<ReferencedCountsItem>);
impl ReferencedCounts { #[must_use] pub fn as_slice(&self) -> &[ReferencedCountsItem] { &self.0 }
fn validate(value: &[ReferencedCountsItem]) -> Result<(), crate::Error> { let _ = value;
Ok(()) } }
impl TryFrom<Vec<ReferencedCountsItem>> for ReferencedCounts { type Error = crate::Error; fn try_from(value: Vec<ReferencedCountsItem>) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ReferencedCounts { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <Vec<ReferencedCountsItem> as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ReferencedMaybe(String);
impl ReferencedMaybe { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("ReferencedMaybe: minLength".into())); }
Ok(()) } }
impl TryFrom<String> for ReferencedMaybe { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ReferencedMaybe { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Referenced {
pub r#counts: ReferencedCounts,
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#maybe: Option<ReferencedMaybe>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct NullableVariant0(String);
impl NullableVariant0 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("NullableVariant0: minLength".into())); }
Ok(()) } }
impl TryFrom<String> for NullableVariant0 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for NullableVariant0 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct NullableVariant1(());
impl NullableVariant1 { #[must_use] pub fn value(&self) -> &() { &self.0 }
fn validate(value: &()) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<()> for NullableVariant1 { type Error = crate::Error; fn try_from(value: ()) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for NullableVariant1 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <() as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum Nullable {
Variant0(NullableVariant0),
Variant1(NullableVariant1),
}
impl<'de> serde::Deserialize<'de> for Nullable { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <NullableVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <NullableVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("Nullable: no union branch matched")) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct Finite(serde_json::Number);
impl Finite { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl PartialEq for Finite { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for Finite { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for Finite { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct NumericConst(serde_json::Number);
impl NumericConst { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("NumericConst: integer".into())); }
if !(crate::compare_number(value, "3").is_eq()) { return Err(crate::Error::Invalid("NumericConst: const".into())); }
Ok(()) } }
impl PartialEq for NumericConst { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for NumericConst { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for NumericConst { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ConstChoiceVariant0(String);
impl ConstChoiceVariant0 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "one" { return Err(crate::Error::Invalid("ConstChoiceVariant0: const".into())); }
Ok(()) } }
impl TryFrom<String> for ConstChoiceVariant0 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ConstChoiceVariant0 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ConstChoiceVariant1(String);
impl ConstChoiceVariant1 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "two" { return Err(crate::Error::Invalid("ConstChoiceVariant1: const".into())); }
Ok(()) } }
impl TryFrom<String> for ConstChoiceVariant1 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ConstChoiceVariant1 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum ConstChoice {
Variant0(ConstChoiceVariant0),
Variant1(ConstChoiceVariant1),
}
impl<'de> serde::Deserialize<'de> for ConstChoice { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <ConstChoiceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <ConstChoiceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("ConstChoice: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct ContextName(String);
impl ContextName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value.is_empty() { return Err(crate::Error::Invalid("ContextName: minLength".into())); }
Ok(()) } }
impl TryFrom<String> for ContextName { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for ContextName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(try_from = "RawContext")]
#[serde(deny_unknown_fields)]
pub struct Context {
#[serde(default, deserialize_with = "crate::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#name: Option<ContextName>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawContext {
#[serde(default, deserialize_with = "crate::deserialize_optional")]
r#name: Option<ContextName>,
}
impl TryFrom<RawContext> for Context { type Error = crate::Error; fn try_from(raw: RawContext) -> Result<Self, Self::Error> {
let count = [raw.r#name.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(crate::Error::Invalid("Context requires context".into())); }
Ok(Self {
r#name: raw.r#name,
}) } }
impl serde::Serialize for Context { fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
let count = [false,self.r#name.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(serde::ser::Error::custom("Context: minProperties")); }
let mut state = serializer.serialize_struct("Context", count)?;
if let Some(value) = &self.r#name { serde::ser::SerializeStruct::serialize_field(&mut state, "name", value)?; }
serde::ser::SerializeStruct::end(state) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct IntegerLimit(serde_json::Number);
impl IntegerLimit { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("IntegerLimit: integer".into())); }
if crate::compare_number(value, "9007199254740992").is_gt() { return Err(crate::Error::Invalid("IntegerLimit: maximum".into())); }
Ok(()) } }
impl PartialEq for IntegerLimit { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for IntegerLimit { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for IntegerLimit { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptSchema(String);
impl GateSlotReceiptSchema { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "gate-slot.receipt/v1" { return Err(crate::Error::Invalid("GateSlotReceiptSchema: const".into())); }
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptSchema { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptSchema { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptHost(String);
impl GateSlotReceiptHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptHost { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptClass(String);
impl GateSlotReceiptClass { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptClass { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptClass { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptPid(serde_json::Number);
impl GateSlotReceiptPid { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("GateSlotReceiptPid: integer".into())); }
if crate::compare_number(value, "1").is_lt() { return Err(crate::Error::Invalid("GateSlotReceiptPid: minimum".into())); }
Ok(()) } }
impl PartialEq for GateSlotReceiptPid { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for GateSlotReceiptPid { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptPid { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCwd(String);
impl GateSlotReceiptCwd { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptCwd { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCwd { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCmdItem(String);
impl GateSlotReceiptCmdItem { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptCmdItem { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCmdItem { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCmd(Vec<GateSlotReceiptCmdItem>);
impl GateSlotReceiptCmd { #[must_use] pub fn as_slice(&self) -> &[GateSlotReceiptCmdItem] { &self.0 }
fn validate(value: &[GateSlotReceiptCmdItem]) -> Result<(), crate::Error> { let _ = value;
if value.len() < 1 { return Err(crate::Error::Invalid("GateSlotReceiptCmd: minItems".into())); }
Ok(()) } }
impl TryFrom<Vec<GateSlotReceiptCmdItem>> for GateSlotReceiptCmd { type Error = crate::Error; fn try_from(value: Vec<GateSlotReceiptCmdItem>) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCmd { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <Vec<GateSlotReceiptCmdItem> as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptStartedAt(String);
impl GateSlotReceiptStartedAt { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptStartedAt { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptStartedAt { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptEndedAt(String);
impl GateSlotReceiptEndedAt { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptEndedAt { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptEndedAt { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptExit(serde_json::Number);
impl GateSlotReceiptExit { #[must_use] pub fn value(&self) -> &serde_json::Number { &self.0 }
fn validate(value: &serde_json::Number) -> Result<(), crate::Error> {
if !crate::is_integer(value) { return Err(crate::Error::Invalid("GateSlotReceiptExit: integer".into())); }
if crate::compare_number(value, "0").is_lt() { return Err(crate::Error::Invalid("GateSlotReceiptExit: minimum".into())); }
Ok(()) } }
impl PartialEq for GateSlotReceiptExit { fn eq(&self, other: &Self) -> bool { crate::numbers_equal(&self.0, &other.0) } }
impl TryFrom<serde_json::Number> for GateSlotReceiptExit { type Error = crate::Error; fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptExit { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Number as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptHeadStart(String);
impl GateSlotReceiptHeadStart { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptHeadStart { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptHeadStart { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptHeadEnd(String);
impl GateSlotReceiptHeadEnd { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptHeadEnd { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptHeadEnd { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptTreeStart(String);
impl GateSlotReceiptTreeStart { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptTreeStart { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptTreeStart { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCleanStartVariant0(bool);
impl GateSlotReceiptCleanStartVariant0 { #[must_use] pub fn value(&self) -> &bool { &self.0 }
fn validate(value: &bool) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<bool> for GateSlotReceiptCleanStartVariant0 { type Error = crate::Error; fn try_from(value: bool) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanStartVariant0 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <bool as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCleanStartVariant1(String);
impl GateSlotReceiptCleanStartVariant1 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "unknown" { return Err(crate::Error::Invalid("GateSlotReceiptCleanStartVariant1: const".into())); }
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptCleanStartVariant1 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanStartVariant1 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum GateSlotReceiptCleanStart {
Variant0(GateSlotReceiptCleanStartVariant0),
Variant1(GateSlotReceiptCleanStartVariant1),
}
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanStart { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <GateSlotReceiptCleanStartVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <GateSlotReceiptCleanStartVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("GateSlotReceiptCleanStart: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCleanEndVariant0(bool);
impl GateSlotReceiptCleanEndVariant0 { #[must_use] pub fn value(&self) -> &bool { &self.0 }
fn validate(value: &bool) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<bool> for GateSlotReceiptCleanEndVariant0 { type Error = crate::Error; fn try_from(value: bool) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanEndVariant0 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <bool as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptCleanEndVariant1(String);
impl GateSlotReceiptCleanEndVariant1 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if value != "unknown" { return Err(crate::Error::Invalid("GateSlotReceiptCleanEndVariant1: const".into())); }
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptCleanEndVariant1 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanEndVariant1 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum GateSlotReceiptCleanEnd {
Variant0(GateSlotReceiptCleanEndVariant0),
Variant1(GateSlotReceiptCleanEndVariant1),
}
impl<'de> serde::Deserialize<'de> for GateSlotReceiptCleanEnd { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <GateSlotReceiptCleanEndVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <GateSlotReceiptCleanEndVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("GateSlotReceiptCleanEnd: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptExact(bool);
impl GateSlotReceiptExact { #[must_use] pub fn value(&self) -> &bool { &self.0 }
fn validate(value: &bool) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<bool> for GateSlotReceiptExact { type Error = crate::Error; fn try_from(value: bool) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptExact { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <bool as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptExpectShort(bool);
impl GateSlotReceiptExpectShort { #[must_use] pub fn value(&self) -> &bool { &self.0 }
fn validate(value: &bool) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<bool> for GateSlotReceiptExpectShort { type Error = crate::Error; fn try_from(value: bool) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptExpectShort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <bool as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptOutcome(String);
impl GateSlotReceiptOutcome { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
if !["not-short", "completed", "failed"].contains(&value) { return Err(crate::Error::Invalid("GateSlotReceiptOutcome: enum".into())); }
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptOutcome { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptOutcome { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptStAgentVariant0(String);
impl GateSlotReceiptStAgentVariant0 { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<String> for GateSlotReceiptStAgentVariant0 { type Error = crate::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptStAgentVariant0 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct GateSlotReceiptStAgentVariant1(());
impl GateSlotReceiptStAgentVariant1 { #[must_use] pub fn value(&self) -> &() { &self.0 }
fn validate(value: &()) -> Result<(), crate::Error> {
let _ = value;
Ok(()) } }
impl TryFrom<()> for GateSlotReceiptStAgentVariant1 { type Error = crate::Error; fn try_from(value: ()) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for GateSlotReceiptStAgentVariant1 { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <() as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum GateSlotReceiptStAgent {
Variant0(GateSlotReceiptStAgentVariant0),
Variant1(GateSlotReceiptStAgentVariant1),
}
impl<'de> serde::Deserialize<'de> for GateSlotReceiptStAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <GateSlotReceiptStAgentVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <GateSlotReceiptStAgentVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("GateSlotReceiptStAgent: no union branch matched")) } }
#[allow(non_snake_case)]
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateSlotReceipt {
pub r#schema: GateSlotReceiptSchema,
pub r#host: GateSlotReceiptHost,
pub r#class: GateSlotReceiptClass,
pub r#pid: GateSlotReceiptPid,
pub r#cwd: GateSlotReceiptCwd,
pub r#cmd: GateSlotReceiptCmd,
pub r#startedAt: GateSlotReceiptStartedAt,
pub r#endedAt: GateSlotReceiptEndedAt,
pub r#exit: GateSlotReceiptExit,
pub r#headStart: GateSlotReceiptHeadStart,
pub r#headEnd: GateSlotReceiptHeadEnd,
pub r#treeStart: GateSlotReceiptTreeStart,
pub r#cleanStart: GateSlotReceiptCleanStart,
pub r#cleanEnd: GateSlotReceiptCleanEnd,
pub r#exact: GateSlotReceiptExact,
pub r#expectShort: GateSlotReceiptExpectShort,
pub r#outcome: GateSlotReceiptOutcome,
pub r#stAgent: GateSlotReceiptStAgent,
}
}
