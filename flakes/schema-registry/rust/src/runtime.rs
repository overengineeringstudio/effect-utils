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
