use std::fmt;

use async_openai::error::OpenAIError;
use serde_json::Value;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Http {
        status: u16,
        r#type: Option<String>,
        message: String,
        raw_body: String,
        retry_after: Option<String>,
    },
    Stream { message: String, raw_body: Option<String> },
    Validation { errors: Vec<String> },
    Transport { message: String },
    Config { message: String },
}

impl Error {
    /// A classification hint only. The client never retries (AIG.RS-R03).
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Http { status: 429 | 500..=599, .. } | Self::Transport { .. })
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::Validation { errors: vec![message.into()] }
    }

    pub(crate) fn http(status: u16, raw_body: String, retry_after: Option<String>) -> Self {
        let parsed = serde_json::from_str::<Value>(&raw_body).ok();
        let error = parsed.as_ref().and_then(|v| v.get("error"));
        let kind = error.and_then(|v| v.get("type")).and_then(Value::as_str).map(str::to_owned);
        let message = error.and_then(|v| v.get("message").and_then(Value::as_str).or_else(|| v.as_str()))
            .or_else(|| parsed.as_ref().and_then(Value::as_str)).unwrap_or(&raw_body).to_owned();
        Self::Http { status, r#type: kind, message, raw_body, retry_after }
    }

    pub(crate) fn from_sdk(error: OpenAIError) -> Self {
        if let OpenAIError::Boxed(boxed) = &error {
            if let Some(error) = boxed.downcast_ref::<Self>() {
                return error.clone();
            }
        }
        match error {
            OpenAIError::Reqwest(error) => Self::Transport { message: error.to_string() },
            OpenAIError::StreamError(error) => Self::Stream { message: error.to_string(), raw_body: None },
            error => Self::validation(error.to_string()),
        }
    }

    pub(crate) fn kind(&self) -> &str {
        match self {
            Self::Http { r#type, .. } => r#type.as_deref().unwrap_or("http_error"),
            Self::Stream { .. } => "stream_error",
            Self::Validation { .. } => "validation_error",
            Self::Transport { .. } => "transport_error",
            Self::Config { .. } => "config_error",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http { status, message, .. } => write!(formatter, "HTTP {status}: {message}"),
            Self::Stream { message, .. } => write!(formatter, "stream: {message}"),
            Self::Validation { errors } => write!(formatter, "validation: {}", errors.join("; ")),
            Self::Transport { message } => write!(formatter, "transport: {message}"),
            Self::Config { message } => write!(formatter, "configuration: {message}"),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_error_bodies_remain_http_failures() {
        for raw in ["upstream unavailable", "\"upstream unavailable\"", "{\"error\":\"upstream unavailable\"}"] {
            let error = Error::http(502, raw.into(), Some("5".into()));
            assert!(error.is_retryable());
            let Error::Http { raw_body, status, message, .. } = error else { panic!("HTTP error required") };
            assert_eq!(raw_body, raw);
            assert_eq!(status, 502);
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn retryability_is_a_hint_not_validation_repair() {
        assert!(!Error::validation("invalid answer").is_retryable());
        assert!(!Error::http(401, "denied".into(), None).is_retryable());
        assert!(Error::http(429, "busy".into(), None).is_retryable());
        assert!(Error::Transport { message: "disconnected".into() }.is_retryable());
        assert!(!Error::Stream { message: "incomplete".into(), raw_body: None }.is_retryable());
    }
}
