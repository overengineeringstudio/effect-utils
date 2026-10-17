// Generated; do not edit. Inputs: src/schema.ts, src/bindings.ts, src/projection.ts, src/generator.ts, src/registry.ts, ../schema-registry/rust/Cargo.toml, ../schema-registry/rust/src/lib.rs, ../schema-registry/rust/src/numbers.rs, ../schema-registry/rust/src/runtime.rs, ../schema-registry/rust/src/bin/schema-registry-rust.rs, rust/Cargo.lock, package.json, ../../.oxfmtrc.json.
// Regenerate: pnpm run generate; sha256=dd1d1e63431851ad32ccc8913860f8aa8bb432d503953d82c9810603e7ce1ca6
pub mod __schema_registry_runtime {
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

}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1Type(String);
impl AgentTraceRuntimeV1Type { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if !["agent-trace-runtime/v1"].contains(&value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1Type: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1Type { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1Type { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoAgent(String);
impl AgentTraceRuntimeV1WhoAgent { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoAgent: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoAgent: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoAgent { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoAgent { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoPrincipal(String);
impl AgentTraceRuntimeV1WhoPrincipal { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPrincipal: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoPrincipal { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoPrincipal { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoActor(String);
impl AgentTraceRuntimeV1WhoActor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoActor: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoActor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoActor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoActor { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoActor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoPersona(String);
impl AgentTraceRuntimeV1WhoPersona { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPersona: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPersona: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoPersona: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoPersona { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoPersona { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhoSupervisor(String);
impl AgentTraceRuntimeV1WhoSupervisor { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:agent(?:\\/[a-z0-9]+(?:-[a-z0-9]+)*)+|(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?(?:direct\\.[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?)$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhoSupervisor: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhoSupervisor { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhoSupervisor { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Who {
pub r#agent: AgentTraceRuntimeV1WhoAgent,
pub r#principal: AgentTraceRuntimeV1WhoPrincipal,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#actor: Option<AgentTraceRuntimeV1WhoActor>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#persona: Option<AgentTraceRuntimeV1WhoPersona>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#supervisor: Option<AgentTraceRuntimeV1WhoSupervisor>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyMissionName(String);
impl AgentTraceRuntimeV1WhyMissionName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyMissionName { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyMissionName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyMissionRun(String);
impl AgentTraceRuntimeV1WhyMissionRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyMissionRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyMissionRun { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyMissionRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1WhyMission {
pub r#name: AgentTraceRuntimeV1WhyMissionName,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceRuntimeV1WhyMissionRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyStepName(String);
impl AgentTraceRuntimeV1WhyStepName { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepName: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepName: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepName: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyStepName { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyStepName { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhyStepRun(String);
impl AgentTraceRuntimeV1WhyStepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[0-9a-f]{32}$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhyStepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhyStepRun { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhyStepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1WhyStep {
pub r#name: AgentTraceRuntimeV1WhyStepName,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#run: Option<AgentTraceRuntimeV1WhyStepRun>,
}
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(try_from = "RawAgentTraceRuntimeV1Why")]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Why {
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#mission: Option<AgentTraceRuntimeV1WhyMission>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#step: Option<AgentTraceRuntimeV1WhyStep>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentTraceRuntimeV1Why {
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional")]
r#mission: Option<AgentTraceRuntimeV1WhyMission>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional")]
r#step: Option<AgentTraceRuntimeV1WhyStep>,
}
impl TryFrom<RawAgentTraceRuntimeV1Why> for AgentTraceRuntimeV1Why { type Error = self::__schema_registry_runtime::Error; fn try_from(raw: RawAgentTraceRuntimeV1Why) -> Result<Self, Self::Error> {
let count = [raw.r#mission.is_some(),raw.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1Why requires context".into())); }
Ok(Self {
r#mission: raw.r#mission,
r#step: raw.r#step,
}) } }
impl serde::Serialize for AgentTraceRuntimeV1Why { fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
let count = [false,self.r#mission.is_some(),self.r#step.is_some(),].into_iter().filter(|present| *present).count(); if count < 1 { return Err(serde::ser::Error::custom("AgentTraceRuntimeV1Why: minProperties")); }
let mut state = serializer.serialize_struct("AgentTraceRuntimeV1Why", count)?;
if let Some(value) = &self.r#mission { serde::ser::SerializeStruct::serialize_field(&mut state, "mission", value)?; }
if let Some(value) = &self.r#step { serde::ser::SerializeStruct::serialize_field(&mut state, "step", value)?; }
serde::ser::SerializeStruct::end(state) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowHarnessTool(String);
impl AgentTraceRuntimeV1HowHarnessTool { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessTool: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowHarnessTool { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowHarnessTool { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowHarnessVersion(String);
impl AgentTraceRuntimeV1HowHarnessVersion { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowHarnessVersion: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowHarnessVersion { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowHarnessVersion { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowHarness {
pub r#tool: AgentTraceRuntimeV1HowHarnessTool,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#version: Option<AgentTraceRuntimeV1HowHarnessVersion>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowModelRoute(String);
impl AgentTraceRuntimeV1HowModelRoute { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: minLength".into())); }
if self::__schema_registry_runtime::utf16_len(value) > 64 { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: maxLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelRoute: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowModelRoute { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowModelRoute { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowModelEffort(String);
impl AgentTraceRuntimeV1HowModelEffort { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowModelEffort: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowModelEffort { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowModelEffort { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowModel {
pub r#route: AgentTraceRuntimeV1HowModelRoute,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#effort: Option<AgentTraceRuntimeV1HowModelEffort>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowToolingProfile(String);
impl AgentTraceRuntimeV1HowToolingProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowToolingProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowToolingProfile { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowToolingProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowRuntimeProfile(String);
impl AgentTraceRuntimeV1HowRuntimeProfile { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowRuntimeProfile: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowRuntimeProfile { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowRuntimeProfile { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowSkillsManifest(String);
impl AgentTraceRuntimeV1HowSkillsManifest { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowSkillsManifest: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowSkillsManifest { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowSkillsManifest { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowInvocationId(String);
impl AgentTraceRuntimeV1HowInvocationId { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowInvocationId: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowInvocationId { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowInvocationId { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0Tag(String);
impl AgentTraceRuntimeV1HowIssuanceVariant0Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if !["st-issued"].contains(&value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant0Tag { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant0Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0StepRun(String);
impl AgentTraceRuntimeV1HowIssuanceVariant0StepRun { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^step-run\\/[0-9a-f]{32}\\/[a-z0-9][a-z0-9._-]*$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant0StepRun: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant0StepRun { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant0StepRun { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant0 {
pub r#_tag: AgentTraceRuntimeV1HowIssuanceVariant0Tag,
pub r#step_run: AgentTraceRuntimeV1HowIssuanceVariant0StepRun,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1Tag(String);
impl AgentTraceRuntimeV1HowIssuanceVariant1Tag { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if !["not-st-issued"].contains(&value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Tag: enum".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant1Tag { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant1Tag { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1Launcher(String);
impl AgentTraceRuntimeV1HowIssuanceVariant1Launcher { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1HowIssuanceVariant1Launcher: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1HowIssuanceVariant1Launcher { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuanceVariant1Launcher { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1HowIssuanceVariant1 {
pub r#_tag: AgentTraceRuntimeV1HowIssuanceVariant1Tag,
pub r#launcher: AgentTraceRuntimeV1HowIssuanceVariant1Launcher,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum AgentTraceRuntimeV1HowIssuance {
Variant0(AgentTraceRuntimeV1HowIssuanceVariant0),
Variant1(AgentTraceRuntimeV1HowIssuanceVariant1),
}
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1HowIssuance { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
if let Ok(branch) = <AgentTraceRuntimeV1HowIssuanceVariant0 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant0(branch)); }
if let Ok(branch) = <AgentTraceRuntimeV1HowIssuanceVariant1 as serde::Deserialize>::deserialize(&value) { return Ok(Self::Variant1(branch)); }
Err(serde::de::Error::custom("AgentTraceRuntimeV1HowIssuance: no union branch matched")) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1How {
pub r#harness: AgentTraceRuntimeV1HowHarness,
pub r#model: AgentTraceRuntimeV1HowModel,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#tooling_profile: Option<AgentTraceRuntimeV1HowToolingProfile>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#runtime_profile: Option<AgentTraceRuntimeV1HowRuntimeProfile>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#skills_manifest: Option<AgentTraceRuntimeV1HowSkillsManifest>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#invocation_id: Option<AgentTraceRuntimeV1HowInvocationId>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#issuance: Option<AgentTraceRuntimeV1HowIssuance>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereSession(String);
impl AgentTraceRuntimeV1WhereSession { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
static PATTERN_2: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new("^(?:[a-z0-9]+(?:-[a-z0-9]+)*\\.)?[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$").expect("schema pattern"));
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereSession: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
if !PATTERN_2.is_match(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereSession: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereSession { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereSession { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereHost(String);
impl AgentTraceRuntimeV1WhereHost { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereHost: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereHost: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereHost: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereHost { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereHost { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(transparent)]
pub struct AgentTraceRuntimeV1WhereWorktree(String);
impl AgentTraceRuntimeV1WhereWorktree { #[must_use] pub fn as_str(&self) -> &str { &self.0 }
pub(crate) fn validate(value: &str) -> Result<(), self::__schema_registry_runtime::Error> {
if value.is_empty() { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: minLength".into())); }
if !self::__schema_registry_runtime::is_js_trimmed(value) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: pattern".into())); }
if value.is_empty() || value.contains(['\r', '\n']) { return Err(self::__schema_registry_runtime::Error::Invalid("AgentTraceRuntimeV1WhereWorktree: pattern".into())); }
Ok(()) } }
impl TryFrom<String> for AgentTraceRuntimeV1WhereWorktree { type Error = self::__schema_registry_runtime::Error; fn try_from(value: String) -> Result<Self, Self::Error> { Self::validate(&value)?; Ok(Self(value)) } }
impl<'de> serde::Deserialize<'de> for AgentTraceRuntimeV1WhereWorktree { fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> { let value = <String as serde::Deserialize>::deserialize(d)?; Self::try_from(value).map_err(serde::de::Error::custom) } }
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1Where {
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#session: Option<AgentTraceRuntimeV1WhereSession>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#host: Option<AgentTraceRuntimeV1WhereHost>,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#worktree: Option<AgentTraceRuntimeV1WhereWorktree>,
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTraceRuntimeV1 {
pub r#type: AgentTraceRuntimeV1Type,
pub r#who: AgentTraceRuntimeV1Who,
#[serde(default, deserialize_with = "self::__schema_registry_runtime::deserialize_optional", skip_serializing_if = "Option::is_none")]
pub r#why: Option<AgentTraceRuntimeV1Why>,
pub r#how: AgentTraceRuntimeV1How,
pub r#where: AgentTraceRuntimeV1Where,
}
