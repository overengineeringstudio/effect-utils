//! Property-based invariants for the two derivation paths whose one real bug
//! (the OK-span error miscount) motivated generalizing example goldens into
//! laws: `derive_spanmetrics::derive` (RED metrics) and `inspect::summarize`.
//!
//! Each test generates an arbitrary trace, runs it through the real code, and
//! asserts the algebraic relationships that must hold for *any* input — the
//! class of guard a single fixture can't give.

use std::collections::BTreeMap;

use otelite::derive_spanmetrics::derive;
use otelite::inspect::{parse_otlp_trace, summarize_trace};
use proptest::prelude::*;
use serde_json::{json, Value};

/// One generated span: (status code 0..3, span kind 0..6, duration ms, name idx).
type SpanSpec = (i64, i64, u64, usize);

const NAMES: [&str; 3] = ["a", "b", "c"];

/// Build a one-line OTLP/JSON capture (single resource/scope) from span specs,
/// in the default OTel-SDK dialect the receiver emits.
fn build_capture(specs: &[SpanSpec]) -> String {
    let spans: Vec<Value> = specs
        .iter()
        .enumerate()
        .map(|(i, &(status, kind, dur_ms, name_idx))| {
            let end = 1_000_000_000u128 + dur_ms as u128 * 1_000_000;
            json!({
                "traceId": "11111111111111111111111111111111",
                "spanId": format!("{i:016x}"),
                "name": NAMES[name_idx],
                "kind": kind,
                "status": { "code": status },
                "startTimeUnixNano": "1000000000",
                "endTimeUnixNano": end.to_string(),
            })
        })
        .collect();
    json!({
        "resourceSpans": [{
            "resource": { "attributes": [
                { "key": "service.name", "value": { "stringValue": "svc" } }
            ]},
            "scopeSpans": [{ "scope": { "name": "t" }, "spans": spans }],
        }]
    })
    .to_string()
}

fn specs_strategy() -> impl Strategy<Value = Vec<SpanSpec>> {
    prop::collection::vec((0i64..3, 0i64..6, 0u64..2000, 0usize..3), 1..40)
}

proptest! {
    /// Spanmetrics `calls` is a faithful partition of the spans: every span is
    /// counted exactly once, and the ERROR subset matches status code 2.
    #[test]
    fn calls_partition_the_spans(specs in specs_strategy()) {
        let rows = derive(&build_capture(&specs)).unwrap();
        let calls: Vec<&Value> = rows.iter().filter(|r| r["name"] == "calls").collect();

        let total: u64 = calls.iter().map(|r| r["value"].as_u64().unwrap()).sum();
        prop_assert_eq!(total, specs.len() as u64, "every span counted once");

        let errors: u64 = calls
            .iter()
            .filter(|r| r["attrs"]["status.code"] == "STATUS_CODE_ERROR")
            .map(|r| r["value"].as_u64().unwrap())
            .sum();
        let expected_errors = specs.iter().filter(|(s, ..)| *s == 2).count() as u64;
        prop_assert_eq!(errors, expected_errors, "only status code 2 is an error");

        // `calls` rows are delta monotonic counters.
        prop_assert!(calls.iter().all(|r| r["monotonic"] == true && r["temporality"] == "delta"));
    }

    /// `calls` and `duration` are one-to-one per dimension, and each `duration`
    /// histogram is internally consistent (buckets sum to count; min≤mean≤max).
    #[test]
    fn duration_histograms_are_consistent(specs in specs_strategy()) {
        let rows = derive(&build_capture(&specs)).unwrap();
        let calls: BTreeMap<String, u64> = rows
            .iter()
            .filter(|r| r["name"] == "calls")
            .map(|r| (r["attrs"].to_string(), r["value"].as_u64().unwrap()))
            .collect();
        let durs: Vec<&Value> = rows.iter().filter(|r| r["name"] == "duration").collect();

        prop_assert_eq!(calls.len(), durs.len(), "one duration per calls dimension");

        for d in durs {
            let count = d["count"].as_u64().unwrap();
            prop_assert_eq!(
                calls.get(&d["attrs"].to_string()).copied(),
                Some(count),
                "duration.count matches the paired calls.value"
            );

            let buckets = d["bucket_counts"].as_array().unwrap();
            prop_assert_eq!(buckets.len(), 17, "16 bounds → 17 buckets");
            let bucket_sum: u64 = buckets.iter().map(|b| b.as_u64().unwrap()).sum();
            prop_assert_eq!(bucket_sum, count, "every observation lands in one bucket");

            if count > 0 {
                let (min, mean, max) = (
                    d["min"].as_f64().unwrap(),
                    d["mean"].as_f64().unwrap(),
                    d["max"].as_f64().unwrap(),
                );
                prop_assert!(min <= mean + 1e-9 && mean <= max + 1e-9, "min ≤ mean ≤ max");
            }
        }
    }

    /// `summarize` preserves the span population and counts errors/zero-durations
    /// by the OTLP status/timing rules — never by span order or grouping.
    #[test]
    fn summary_counts_match_the_population(specs in specs_strategy()) {
        let snapshot = parse_otlp_trace(
            &serde_json::from_str::<Value>(&build_capture(&specs)).unwrap(),
            "11111111111111111111111111111111",
        );
        let s = summarize_trace(&snapshot, 10_000);

        prop_assert_eq!(s["span_count"].as_u64().unwrap(), specs.len() as u64);
        prop_assert_eq!(
            s["error_span_count"].as_u64().unwrap(),
            specs.iter().filter(|(c, ..)| *c == 2).count() as u64
        );
        prop_assert_eq!(
            s["zero_duration_span_count"].as_u64().unwrap(),
            specs.iter().filter(|(_, _, d, _)| *d == 0).count() as u64
        );

        prop_assert!(matches!(
            s["timing_confidence"].as_str().unwrap(),
            "none" | "partial" | "high"
        ));

        // Single non-empty service ⇒ its one group accounts for every span.
        let by_service = s["grouped_duration_by_service"].as_array().unwrap();
        let grouped: u64 = by_service.iter().map(|g| g["span_count"].as_u64().unwrap()).sum();
        prop_assert_eq!(grouped, specs.len() as u64, "grouping loses no spans");
    }
}
