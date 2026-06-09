//! Trace summarization: bottleneck ranking, exclusive durations, timing
//! confidence, and grouped aggregations.
//!
//! [`summarize_trace`] reduces a [`TraceSnapshot`] to a JSON summary: slowest
//! spans (with self/exclusive time computed via interval-merge over children),
//! error spans, per-service and per-name duration rollups, top labels, and a
//! `timing_confidence` signal derived from how many work spans have zero
//! duration. Instant-event spans (zero-duration markers) are classified
//! separately so they don't pollute the bottleneck ranking.
//!
//! The entire output shape is golden-locked — the conformance goldens under
//! `tests/conformance/` assert on the exact JSON. Do not change any computation
//! or field here without updating the goldens.

use serde_json::{json, Value};

use super::model::{SpanRow, TraceSnapshot};

/// Summarize a trace to a JSON value. `top` bounds the size of every ranked /
/// grouped list (slow spans, error spans, grouped durations, top labels).
pub fn summarize_trace(snapshot: &TraceSnapshot, top: usize) -> Value {
    let trace_start = snapshot
        .spans
        .iter()
        .map(|s| s.start_time_unix_nano)
        .min()
        .unwrap_or(0);
    let trace_end = snapshot
        .spans
        .iter()
        .map(|s| s.end_time_unix_nano)
        .max()
        .unwrap_or(0);
    let total_ms = nanos_to_ms(trace_end.saturating_sub(trace_start));
    let errors: Vec<_> = snapshot
        .spans
        .iter()
        .filter(|s| s.status_code != 0)
        .collect();
    let zero_duration_spans = snapshot
        .spans
        .iter()
        .filter(|s| span_duration_nanos(s) == 0)
        .count();
    let instant_event_spans = snapshot
        .spans
        .iter()
        .filter(|s| is_instant_event_span(s))
        .count();
    let zero_duration_work_spans = snapshot
        .spans
        .iter()
        .filter(|s| span_duration_nanos(s) == 0 && !is_instant_event_span(s))
        .count();
    let exclusive_by_span = exclusive_duration_by_span(snapshot);
    let mut spans: Vec<_> = snapshot.spans.iter().collect();
    spans.sort_by(|a, b| {
        span_duration_nanos(b)
            .cmp(&span_duration_nanos(a))
            .then(a.service_name.cmp(&b.service_name))
            .then(a.name.cmp(&b.name))
    });
    let slow_spans: Vec<Value> = spans
        .into_iter()
        .take(top.max(1))
        .map(|span| {
            let exclusive_nanos = exclusive_by_span
                .get(&span.span_id)
                .copied()
                .unwrap_or_else(|| span_duration_nanos(span));
            json!({
                "inclusive_duration_ms": span_duration_ms(span),
                "exclusive_duration_ms": nanos_to_ms(exclusive_nanos),
                "relative_start_ms": nanos_to_ms(span.start_time_unix_nano.saturating_sub(trace_start)),
                "service_name": span.service_name,
                "name": span.name,
                "span_id": span.span_id,
                "parent_span_id": span.parent_span_id,
                "label": attr_value(span, "span.label"),
                "instant_event": is_instant_event_span(span),
            })
        })
        .collect();
    let error_spans: Vec<Value> = errors
        .iter()
        .take(top.max(1))
        .map(|span| {
            let exclusive_nanos = exclusive_by_span
                .get(&span.span_id)
                .copied()
                .unwrap_or_else(|| span_duration_nanos(span));
            json!({
                "inclusive_duration_ms": span_duration_ms(span),
                "exclusive_duration_ms": nanos_to_ms(exclusive_nanos),
                "service_name": span.service_name,
                "name": span.name,
                "span_id": span.span_id,
                "label": attr_value(span, "span.label"),
                "instant_event": is_instant_event_span(span),
            })
        })
        .collect();
    let grouped_by_service = grouped_duration(
        snapshot.spans.iter().map(|span| {
            (
                span.service_name.as_str(),
                span_duration_nanos(span),
                exclusive_by_span
                    .get(&span.span_id)
                    .copied()
                    .unwrap_or_else(|| span_duration_nanos(span)),
                span_duration_nanos(span) == 0,
                is_instant_event_span(span),
            )
        }),
        top,
    );
    let grouped_by_name = grouped_duration(
        snapshot.spans.iter().map(|span| {
            (
                span.name.as_str(),
                span_duration_nanos(span),
                exclusive_by_span
                    .get(&span.span_id)
                    .copied()
                    .unwrap_or_else(|| span_duration_nanos(span)),
                span_duration_nanos(span) == 0,
                is_instant_event_span(span),
            )
        }),
        top,
    );
    let top_labels = grouped_count(
        snapshot
            .spans
            .iter()
            .filter_map(|span| attr_value(span, "span.label")),
        top,
    );
    let work_span_count = snapshot.spans.len().saturating_sub(instant_event_spans);
    let timing_confidence = timing_confidence(work_span_count, zero_duration_work_spans);
    let warnings = if zero_duration_work_spans == work_span_count && work_span_count > 0 {
        vec!["work span durations are all zero; use timestamps, events, or instrumentation fixes before trusting bottleneck ranking"]
    } else if zero_duration_work_spans > 0 {
        vec!["some work spans have zero duration; slow-span ranking may be incomplete"]
    } else {
        Vec::new()
    };
    json!({
        "trace_id": snapshot.trace_id,
        "otlp_trace_id": snapshot.otlp_trace_id,
        "root_service": snapshot.root_service,
        "span_count": snapshot.spans.len(),
        "duration_ms": total_ms,
        "error_span_count": errors.len(),
        "zero_duration_span_count": zero_duration_spans,
        "instant_event_span_count": instant_event_spans,
        "zero_duration_work_span_count": zero_duration_work_spans,
        "timing_confidence": timing_confidence,
        "warnings": warnings,
        "slow_spans": slow_spans,
        "error_spans": error_spans,
        "grouped_duration_by_service": grouped_by_service,
        "grouped_duration_by_name": grouped_by_name,
        "top_labels": top_labels,
    })
}

/// Aggregate `(key, inclusive, exclusive, is_zero, is_instant)` rows by key,
/// summing durations/counts, then rank by exclusive then inclusive then count
/// then key. Empty keys are dropped. Returns at most `limit` rows.
fn grouped_duration<'a>(
    rows: impl Iterator<Item = (&'a str, u128, u128, bool, bool)>,
    limit: usize,
) -> Vec<Value> {
    #[derive(Default)]
    struct Agg {
        count: u64,
        inclusive_nanos: u128,
        exclusive_nanos: u128,
        zero_duration_count: u64,
        instant_event_count: u64,
    }
    let mut grouped = std::collections::BTreeMap::<String, Agg>::new();
    for (key, inclusive_nanos, exclusive_nanos, zero_duration, instant_event) in rows {
        if key.is_empty() {
            continue;
        }
        let entry = grouped.entry(key.to_string()).or_default();
        entry.count += 1;
        entry.inclusive_nanos = entry.inclusive_nanos.saturating_add(inclusive_nanos);
        entry.exclusive_nanos = entry.exclusive_nanos.saturating_add(exclusive_nanos);
        if zero_duration {
            entry.zero_duration_count += 1;
        }
        if instant_event {
            entry.instant_event_count += 1;
        }
    }
    let mut rows: Vec<_> = grouped.into_iter().collect();
    rows.sort_by(|(a_key, a), (b_key, b)| {
        b.exclusive_nanos
            .cmp(&a.exclusive_nanos)
            .then(b.inclusive_nanos.cmp(&a.inclusive_nanos))
            .then(b.count.cmp(&a.count))
            .then(a_key.cmp(b_key))
    });
    rows.into_iter()
        .take(limit.max(1))
        .map(|(key, agg)| {
            json!({
                "key": key,
                "span_count": agg.count,
                "inclusive_duration_ms": nanos_to_ms(agg.inclusive_nanos),
                "exclusive_duration_ms": nanos_to_ms(agg.exclusive_nanos),
                "zero_duration_span_count": agg.zero_duration_count,
                "instant_event_span_count": agg.instant_event_count,
            })
        })
        .collect()
}

/// Count occurrences of each value, rank by count then value, return up to
/// `limit` rows.
fn grouped_count(values: impl Iterator<Item = String>, limit: usize) -> Vec<Value> {
    let mut grouped = std::collections::BTreeMap::<String, u64>::new();
    for value in values {
        if !value.is_empty() {
            *grouped.entry(value).or_default() += 1;
        }
    }
    let mut rows: Vec<_> = grouped.into_iter().collect();
    rows.sort_by(|(a_key, a_count), (b_key, b_count)| b_count.cmp(a_count).then(a_key.cmp(b_key)));
    rows.into_iter()
        .take(limit.max(1))
        .map(|(value, count)| json!({ "value": value, "count": count }))
        .collect()
}

/// How much to trust the duration data: `none` if every work span is
/// zero-duration, `partial` if some are, `high` otherwise.
fn timing_confidence(span_count: usize, zero_duration_count: usize) -> &'static str {
    if span_count == 0 || zero_duration_count == span_count {
        "none"
    } else if zero_duration_count > 0 {
        "partial"
    } else {
        "high"
    }
}

fn span_duration_nanos(span: &SpanRow) -> u128 {
    span.end_time_unix_nano
        .saturating_sub(span.start_time_unix_nano)
}

/// Exclusive (self) duration per span: inclusive duration minus the union of
/// its direct children's time ranges (clipped to the parent and interval-merged
/// so overlapping children aren't double-counted).
fn exclusive_duration_by_span(
    snapshot: &TraceSnapshot,
) -> std::collections::BTreeMap<String, u128> {
    let mut children = std::collections::BTreeMap::<String, Vec<(u128, u128)>>::new();
    for span in &snapshot.spans {
        if let Some(parent) = span.parent_span_id.as_ref() {
            children
                .entry(parent.clone())
                .or_default()
                .push((span.start_time_unix_nano, span.end_time_unix_nano));
        }
    }

    let mut out = std::collections::BTreeMap::new();
    for span in &snapshot.spans {
        let inclusive = span_duration_nanos(span);
        let child_covered = children
            .get(&span.span_id)
            .map(|intervals| {
                covered_child_duration(
                    intervals,
                    span.start_time_unix_nano,
                    span.end_time_unix_nano,
                )
            })
            .unwrap_or(0);
        out.insert(
            span.span_id.clone(),
            inclusive.saturating_sub(child_covered),
        );
    }
    out
}

/// Total length of the union of child intervals, each clipped to `[start, end]`
/// and then merged so overlaps count once.
fn covered_child_duration(intervals: &[(u128, u128)], start: u128, end: u128) -> u128 {
    let mut clipped: Vec<(u128, u128)> = intervals
        .iter()
        .filter_map(|(child_start, child_end)| {
            let s = (*child_start).max(start);
            let e = (*child_end).min(end);
            (e > s).then_some((s, e))
        })
        .collect();
    clipped.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut total = 0u128;
    let mut current: Option<(u128, u128)> = None;
    for (s, e) in clipped {
        match current {
            None => current = Some((s, e)),
            Some((cs, ce)) if s <= ce => current = Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                total = total.saturating_add(ce.saturating_sub(cs));
                current = Some((s, e));
            }
        }
    }
    if let Some((cs, ce)) = current {
        total = total.saturating_add(ce.saturating_sub(cs));
    }
    total
}

/// A zero-duration span whose name marks it as an instant event rather than
/// missing timing data. The name set is otelite/nix-trace specific and part of
/// the golden contract.
fn is_instant_event_span(span: &SpanRow) -> bool {
    span_duration_nanos(span) == 0
        && matches!(
            span.name.as_str(),
            "nix.warning" | "nix.build.phase.transition"
        )
}

fn span_duration_ms(span: &SpanRow) -> f64 {
    nanos_to_ms(span_duration_nanos(span))
}

fn nanos_to_ms(nanos: u128) -> f64 {
    nanos as f64 / 1_000_000.0
}

/// First non-empty attribute value for `key`, if any.
fn attr_value(span: &SpanRow, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|a| a.key == key)
        .map(|a| a.value.clone())
        .filter(|v| !v.is_empty())
}
