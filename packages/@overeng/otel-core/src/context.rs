//! W3C trace-context propagation primitives (registry-agnostic).
//!
//! Owns the `TraceContext` produced from an inbound `traceparent` (or freshly
//! minted when absent) plus the `traceparent` header parse/format (otel-core
//! spec module `otel_core::context`). Extracted from `otel-scrape`; the OTLP
//! exporter there consumes `TraceContext` but this module has no dependency back
//! on the wrapper (one-way `otel-scrape -> otel-core`).

use std::io;

use crate::hex::{is_lower_hex, random_hex};

/// Inbound W3C traceparent env var. Lower-case per the propagation convention
/// some emitters use; the upper-case `TRACEPARENT` is also honored as a fallback.
const TRACEPARENT_ENV: &str = "traceparent";
/// W3C `sampled` trace-flags byte.
const TRACE_FLAGS_SAMPLED: &str = "01";

/// A resolved W3C trace context for the current span: the shared `trace_id`, an
/// optional inherited `parent_span_id`, this span's freshly minted `span_id`,
/// and the propagated trace `flags`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub parent_span_id: Option<String>,
    pub span_id: String,
    pub flags: String,
}

impl TraceContext {
    /// The `traceparent` header a child process should inherit: this context's
    /// own span becomes the child's parent.
    pub fn child_traceparent(&self) -> String {
        format!("00-{}-{}-{}", self.trace_id, self.span_id, self.flags)
    }
}

/// Build a `TraceContext` from the ambient environment: continue an inbound
/// `traceparent` when present and valid, otherwise mint a fresh root trace.
pub fn trace_context_from_env() -> io::Result<TraceContext> {
    let parent = std::env::var(TRACEPARENT_ENV)
        .ok()
        .or_else(|| std::env::var("TRACEPARENT").ok())
        .and_then(|value| parse_traceparent(&value));

    let span_id = random_hex(8)?;
    match parent {
        Some(parent) => Ok(TraceContext {
            trace_id: parent.trace_id,
            parent_span_id: Some(parent.span_id),
            span_id,
            flags: parent.flags,
        }),
        None => Ok(TraceContext {
            trace_id: random_hex(16)?,
            parent_span_id: None,
            span_id,
            flags: String::from(TRACE_FLAGS_SAMPLED),
        }),
    }
}

#[derive(Debug, Clone)]
struct ParsedTraceparent {
    trace_id: String,
    span_id: String,
    flags: String,
}

fn parse_traceparent(value: &str) -> Option<ParsedTraceparent> {
    let mut parts = value.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if version != "00" || !is_lower_hex(trace_id, 32) || !is_lower_hex(span_id, 16) {
        return None;
    }
    if !is_lower_hex(flags, 2)
        || trace_id.chars().all(|c| c == '0')
        || span_id.chars().all(|c| c == '0')
    {
        return None;
    }
    Some(ParsedTraceparent {
        trace_id: trace_id.to_owned(),
        span_id: span_id.to_owned(),
        flags: flags.to_owned(),
    })
}
