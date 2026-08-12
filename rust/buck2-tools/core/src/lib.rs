use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

pub type ToolResult<T> = Result<T, ToolError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "error[{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolError {}

pub fn io_error(code: &'static str, context: &str, error: io::Error) -> ToolError {
    ToolError::new(code, format!("{context}: {error}"))
}

pub fn sha256_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

pub fn sha256_file(path: &Path) -> ToolResult<String> {
    let mut source = File::open(path)
        .map_err(|error| io_error("BUCK2_IO", &format!("could not read {}", path.display()), error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| io_error("BUCK2_IO", "could not hash input", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{digest:x}"))
}

pub fn sha256_sri(hex_digest: &str) -> ToolResult<String> {
    if !is_sha256(hex_digest) {
        return Err(ToolError::new(
            "BUCK2_INVALID_DIGEST",
            "sha256 must contain exactly 64 lowercase hexadecimal characters",
        ));
    }
    let bytes = (0..hex_digest.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex_digest[index..index + 2], 16).expect("validated hex"))
        .collect::<Vec<_>>();
    Ok(format!("sha256-{}", STANDARD.encode(bytes)))
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn canonical_json<T: Serialize>(value: &T) -> ToolResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| {
        ToolError::new("BUCK2_JSON", format!("could not serialize canonical JSON: {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn pretty_json<T: Serialize>(value: &T) -> ToolResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        ToolError::new("BUCK2_JSON", format!("could not serialize JSON: {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn normalized_relative(value: &str, field: &str) -> ToolResult<String> {
    if value.is_empty() {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must be a non-empty string"),
        ));
    }
    if value.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must not contain control characters"),
        ));
    }
    if value.starts_with('/') || value.contains('\\') {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must be a normalized relative path: {value:?}"),
        ));
    }
    if value.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(ToolError::new(
            "BUCK2_INVALID_PATH",
            format!("{field} must not traverse and must be a normalized relative path: {value:?}"),
        ));
    }
    Ok(value.to_owned())
}

pub fn safe_text(value: &str, field: &str) -> ToolResult<String> {
    if value.is_empty() || value.bytes().any(|byte| byte == 0 || byte == b'\n' || byte == b'\r') {
        return Err(ToolError::new(
            "BUCK2_INVALID_TEXT",
            format!("{field} must be non-empty and contain no control characters"),
        ));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_contract_is_posix_relative_and_normalized() {
        assert_eq!(normalized_relative("bin/tool", "path").unwrap(), "bin/tool");
        for bad in ["", "/bin/tool", "bin/../tool", "bin//tool", "./bin/tool", "bin\\tool"] {
            assert!(normalized_relative(bad, "path").is_err(), "accepted {bad:?}");
        }
    }
}
