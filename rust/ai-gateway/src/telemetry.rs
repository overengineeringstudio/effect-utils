use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::{Error, Usage};

pub(crate) struct Operation {
    pub(crate) span: Span,
    ended: bool,
}

impl Operation {
    pub(crate) fn new(operation: &str, model: &str) -> Self {
        let label = format!("{operation} {model}");
        let span = tracing::info_span!(
            "ai_gateway.operation",
            otel.name = %label,
            otel.kind = "client",
            otel.status_code = tracing::field::Empty,
            gen_ai.operation.name = operation,
            gen_ai.request.model = model,
            span.label = %label,
            error.type = tracing::field::Empty,
        );
        Self { span, ended: false }
    }

    pub(crate) fn metadata(
        &self,
        model: Option<&str>,
        id: Option<&str>,
        reason: Option<&str>,
        usage: Option<&Usage>,
    ) {
        if let Some(model) = model {
            self.span
                .set_attribute("gen_ai.response.model", model.to_owned());
        }
        if let Some(id) = id {
            self.span.set_attribute("gen_ai.response.id", id.to_owned());
        }
        if let Some(reason) = reason {
            self.span.set_attribute(
                "gen_ai.response.finish_reasons",
                opentelemetry::Value::Array(opentelemetry::Array::String(vec![reason
                    .to_owned()
                    .into()])),
            );
        }
        if let Some(usage) = usage {
            for (key, value) in [
                ("gen_ai.usage.input_tokens", usage.input),
                ("gen_ai.usage.output_tokens", usage.output),
                ("gen_ai.usage.cache_read.input_tokens", usage.cached),
                ("gen_ai.usage.reasoning.output_tokens", usage.reasoning),
            ] {
                if let Some(value) = value {
                    // OTel integer values are signed; do not invent a wrapped negative count.
                    if let Ok(value) = i64::try_from(value) {
                        self.span.set_attribute(key, value);
                    }
                }
            }
        }
    }

    pub(crate) fn finish<T>(&mut self, result: &crate::Result<T>) {
        match result {
            Ok(_) => {
                self.span.record("otel.status_code", "OK");
            }
            Err(error) => self.error(error),
        }
        self.ended = true;
        self.span = Span::none();
    }

    pub(crate) fn error(&self, error: &Error) {
        self.span.record("otel.status_code", "ERROR");
        self.span.record("error.type", error.kind());
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if !self.ended {
            self.span.record("otel.status_code", "ERROR");
            self.span.record("error.type", "cancelled");
        }
    }
}
