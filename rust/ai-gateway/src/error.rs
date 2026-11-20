use std::fmt;

use crate::Usage;
use async_openai::error::OpenAIError;
use serde_json::Value;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Tool-run failure with usage evidence from all completed model exchanges.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolRunError {
    pub error: Error,
    pub exchanges: Vec<Option<Usage>>,
    pub total: Option<Usage>,
}

impl fmt::Display for ToolRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for ToolRunError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

/// Caller-visible evidence for malformed JSON or original-schema violations.
#[derive(Clone, PartialEq)]
pub struct StructuredOutputError {
    pub errors: Vec<String>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,
    /// UTF-8 prefix, at most 2048 bytes including the truncation marker.
    raw_text: String,
    /// Byte length of the complete response text, before truncation.
    pub raw_text_bytes: usize,
    pub truncated: bool,
}

impl StructuredOutputError {
    /// Explicitly access sensitive model-generated response text.
    pub fn raw_text(&self) -> &str {
        &self.raw_text
    }
}

impl fmt::Debug for StructuredOutputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StructuredOutputError")
            .field("errors", &self.errors)
            .field("usage", &self.usage)
            .field("finish_reason", &self.finish_reason)
            .field("raw_text", &"[REDACTED]")
            .field("raw_text_bytes", &self.raw_text_bytes)
            .field("truncated", &self.truncated)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Http {
        status: u16,
        r#type: Option<String>,
        message: String,
        raw_body: String,
        retry_after: Option<String>,
    },
    Stream {
        message: String,
        raw_body: Option<String>,
    },
    /// Local rejection; usage is retained when the provider already billed a response.
    Validation {
        errors: Vec<String>,
        usage: Option<Usage>,
    },
    /// Structured response rejected after parsing or original-schema validation.
    /// Raw text is caller-visible only; Display and telemetry omit the excerpt.
    StructuredOutput(Box<StructuredOutputError>),
    Transport {
        message: String,
    },
    Config {
        message: String,
    },
}

impl Error {
    /// A classification hint only. The client never retries (AIG.RS-R03).
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Http {
                status: 429 | 500..=599,
                ..
            } | Self::Transport { .. }
        )
    }

    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self::Validation {
            errors: vec![message.into()],
            usage: None,
        }
    }

    pub(crate) fn with_usage(mut self, usage: Option<Usage>) -> Self {
        if let Self::Validation { usage: billed, .. } = &mut self {
            *billed = usage;
        }
        self
    }

    pub(crate) fn structured_output(
        errors: Vec<String>,
        usage: Option<Usage>,
        finish_reason: Option<String>,
        mut raw_text: String,
    ) -> Self {
        const LIMIT: usize = 2048;
        const MARKER: &str = "\n[truncated]";
        let raw_text_bytes = raw_text.len();
        let truncated = raw_text_bytes > LIMIT;
        if truncated {
            let mut end = LIMIT - MARKER.len();
            while !raw_text.is_char_boundary(end) {
                end -= 1;
            }
            raw_text = format!("{}{MARKER}", &raw_text[..end]);
        }
        Self::StructuredOutput(Box::new(StructuredOutputError {
            errors,
            usage,
            finish_reason,
            raw_text,
            raw_text_bytes,
            truncated,
        }))
    }

    pub(crate) fn http(status: u16, raw_body: String, retry_after: Option<String>) -> Self {
        let parsed = serde_json::from_str::<Value>(&raw_body).ok();
        let error = parsed.as_ref().and_then(|v| v.get("error"));
        let kind = error
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let message = error
            .and_then(|v| {
                v.get("message")
                    .and_then(Value::as_str)
                    .or_else(|| v.as_str())
            })
            .or_else(|| parsed.as_ref().and_then(Value::as_str))
            .unwrap_or(&raw_body)
            .to_owned();
        Self::Http {
            status,
            r#type: kind,
            message,
            raw_body,
            retry_after,
        }
    }

    pub(crate) fn from_sdk(error: OpenAIError) -> Self {
        if let OpenAIError::Boxed(boxed) = &error {
            if let Some(error) = boxed.downcast_ref::<Self>() {
                return error.clone();
            }
        }
        match error {
            OpenAIError::Reqwest(error) => Self::Transport {
                message: error.to_string(),
            },
            OpenAIError::StreamError(error) => Self::Stream {
                message: error.to_string(),
                raw_body: None,
            },
            error => Self::validation(error.to_string()),
        }
    }

    pub(crate) fn kind(&self) -> &str {
        match self {
            Self::Http { r#type, .. } => r#type.as_deref().unwrap_or("http_error"),
            Self::Stream { .. } => "stream_error",
            Self::Validation { .. } | Self::StructuredOutput(_) => "validation_error",
            Self::Transport { .. } => "transport_error",
            Self::Config { .. } => "config_error",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http {
                status, message, ..
            } => write!(formatter, "HTTP {status}: {message}"),
            Self::Stream { message, .. } => write!(formatter, "stream: {message}"),
            Self::StructuredOutput(error) => {
                write!(formatter, "validation: {}", error.errors.join("; "))
            }
            Self::Validation { errors, .. } => {
                write!(formatter, "validation: {}", errors.join("; "))
            }
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
    fn structured_output_debug_redacts_excerpt_for_payload_and_error() {
        let text = "sensitive-response-excerpt";
        let error = Error::structured_output(
            vec!["expected value".into()],
            None,
            Some("length".into()),
            text.into(),
        );
        let Error::StructuredOutput(payload) = &error else {
            panic!("expected structured output failure");
        };
        assert_eq!(payload.raw_text(), text);
        for debug in [format!("{payload:?}"), format!("{error:?}")] {
            assert!(!debug.contains(text));
            assert!(debug.contains("[REDACTED]"));
            assert!(debug.contains("raw_text_bytes: 26"));
            assert!(debug.contains("truncated: false"));
            assert!(debug.contains("length"));
            assert!(debug.contains("expected value"));
            assert!(debug.contains("usage: None"));
        }
    }

    #[test]
    fn unknown_error_bodies_remain_http_failures() {
        for raw in [
            "upstream unavailable",
            "\"upstream unavailable\"",
            "{\"error\":\"upstream unavailable\"}",
        ] {
            let error = Error::http(502, raw.into(), Some("5".into()));
            assert!(error.is_retryable());
            let Error::Http {
                raw_body,
                status,
                message,
                ..
            } = error
            else {
                panic!("HTTP error required")
            };
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
        assert!(Error::Transport {
            message: "disconnected".into()
        }
        .is_retryable());
        assert!(!Error::Stream {
            message: "incomplete".into(),
            raw_body: None
        }
        .is_retryable());
    }
}
