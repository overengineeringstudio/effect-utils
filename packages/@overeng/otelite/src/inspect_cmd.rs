//! The `inspect` verb: read a capture, group spans by trace, and emit either
//! flat `otelite.span/v1` rows or a per-trace `--summary`. The trace analysis
//! itself is the golden-locked [`crate::inspect`] core; this module only adapts
//! the NDJSON capture into per-trace OTLP values and shapes the CLI output.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::inspect::{parse_otlp_trace, summarize_trace};

/// Options for `inspect`, parsed from the CLI.
pub struct InspectOpts {
    /// Capture source: a dir (uses `<dir>/<signal>.ndjson`), a file, or `-` (stdin).
    pub src: String,
    /// Which signal to read (only `traces` at v1; metrics/logs land in M6).
    pub signal: String,
    pub service: Option<String>,
    pub name: Option<String>,
    /// `key=value` attribute filters (all must match).
    pub attrs: Vec<(String, String)>,
    /// Emit one per-trace summary object instead of flat span rows.
    pub summary: bool,
    /// Bound for ranked/grouped lists in `--summary`.
    pub top: usize,
    pub pretty: bool,
}

const EX_USAGE: u8 = 64;
const EX_DATAERR: u8 = 65; // corrupt capture / decode error
const EX_NOINPUT: u8 = 66; // missing/unreadable source
const EX_UNAVAILABLE: u8 = 69; // signal not implemented yet

pub fn inspect(opts: InspectOpts) -> u8 {
    if opts.signal != "traces" {
        eprintln!(
            "otelite: inspect --signal {} is not yet implemented (epic #772, M6)",
            opts.signal
        );
        return EX_UNAVAILABLE;
    }

    let raw = match read_source(&opts.src, &opts.signal) {
        Ok(r) => r,
        Err(code) => return code,
    };

    // Group every captured span by traceId into one OTLP value per trace.
    let traces = match group_by_trace(&raw) {
        Ok(t) => t,
        Err(code) => return code,
    };

    let mut out = String::new();
    for (trace_id, value) in &traces {
        let snapshot = parse_otlp_trace(value, trace_id);
        if opts.summary {
            let mut report = summarize_trace(&snapshot, opts.top);
            if let Value::Object(m) = &mut report {
                m.insert("schema".into(), json!("otelite.trace-summary/v1"));
            }
            emit(&mut out, &report, opts.pretty);
        } else {
            for span in &snapshot.spans {
                let row = span_row(trace_id, span);
                if !matches(&row, &opts) {
                    continue;
                }
                emit(&mut out, &row, opts.pretty);
            }
        }
    }
    print!("{out}");
    0
}

/// Read the capture source into its raw NDJSON text.
fn read_source(src: &str, signal: &str) -> Result<String, u8> {
    if src == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| {
            eprintln!("otelite: cannot read stdin: {e}");
            EX_NOINPUT
        })?;
        // `run | inspect -`: stdin is the run summary, not the capture. Follow
        // its `.out` to the capture file so the advertised pipe composes.
        if let Some(first) = s.lines().find(|l| !l.trim().is_empty()) {
            if let Ok(v) = serde_json::from_str::<Value>(first) {
                if v.get("schema").and_then(Value::as_str) == Some("otelite.summary/v1") {
                    let Some(out) = v.get("out").and_then(Value::as_str) else {
                        eprintln!("otelite: run summary on stdin has no `.out` to inspect");
                        return Err(EX_DATAERR);
                    };
                    return read_file(&PathBuf::from(out).join(format!("{signal}.ndjson")));
                }
            }
        }
        return Ok(s); // raw capture NDJSON on stdin
    }
    let path = PathBuf::from(src);
    let file = if path.is_dir() {
        path.join(format!("{signal}.ndjson"))
    } else {
        path
    };
    read_file(&file)
}

fn read_file(file: &Path) -> Result<String, u8> {
    std::fs::read_to_string(file).map_err(|e| {
        eprintln!("otelite: cannot read {}: {e}", file.display());
        EX_NOINPUT
    })
}

/// Partition all captured spans into one `{"resourceSpans":[...]}` value per
/// distinct traceId, preserving each span's resource + scope.
fn group_by_trace(raw: &str) -> Result<Vec<(String, Value)>, u8> {
    // trace_id -> resourceSpans array (each entry holds one scopeSpan of spans).
    let mut by_trace: BTreeMap<String, Vec<Value>> = BTreeMap::new();

    for (lineno, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).map_err(|e| {
            eprintln!("otelite: corrupt capture at line {}: {e}", lineno + 1);
            EX_DATAERR
        })?;
        for rs in v
            .get("resourceSpans")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resource = rs.get("resource").cloned().unwrap_or(Value::Null);
            for ss in rs
                .get("scopeSpans")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let scope = ss.get("scope").cloned().unwrap_or(Value::Null);
                // Bucket this scope's spans by traceId.
                let mut buckets: BTreeMap<String, Vec<Value>> = BTreeMap::new();
                for span in ss
                    .get("spans")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let tid = span
                        .get("traceId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    buckets.entry(tid).or_default().push(span.clone());
                }
                for (tid, spans) in buckets {
                    let rs_for_trace = json!({
                        "resource": resource,
                        "scopeSpans": [ { "scope": scope, "spans": spans } ],
                    });
                    by_trace.entry(tid).or_default().push(rs_for_trace);
                }
            }
        }
    }

    Ok(by_trace
        .into_iter()
        .map(|(tid, resource_spans)| (tid, json!({ "resourceSpans": resource_spans })))
        .collect())
}

/// Build a flat `otelite.span/v1` row from a salvaged SpanRow + its trace id.
fn span_row(trace_id: &str, span: &crate::inspect::SpanRow) -> Value {
    let attrs: serde_json::Map<String, Value> = span
        .attributes
        .iter()
        .map(|a| (a.key.clone(), json!(a.value)))
        .collect();
    let duration_ms = (span
        .end_time_unix_nano
        .saturating_sub(span.start_time_unix_nano)) as f64
        / 1_000_000.0;
    json!({
        "schema": "otelite.span/v1",
        "trace_id": trace_id,
        "span_id": span.span_id,
        "parent_span_id": span.parent_span_id,
        "service": span.service_name,
        "name": span.name,
        "start_unix_nano": span.start_time_unix_nano.to_string(),
        "end_unix_nano": span.end_time_unix_nano.to_string(),
        "duration_ms": duration_ms,
        "status_code": span.status_code,
        "attrs": attrs,
    })
}

/// Apply the `--service` / `--name` / `--attr` filters to a flat row.
fn matches(row: &Value, opts: &InspectOpts) -> bool {
    if let Some(s) = &opts.service {
        if row["service"].as_str() != Some(s.as_str()) {
            return false;
        }
    }
    if let Some(n) = &opts.name {
        if row["name"].as_str() != Some(n.as_str()) {
            return false;
        }
    }
    for (k, v) in &opts.attrs {
        if row["attrs"].get(k).and_then(Value::as_str) != Some(v.as_str()) {
            return false;
        }
    }
    true
}

fn emit(out: &mut String, value: &Value, pretty: bool) {
    let s = if pretty {
        serde_json::to_string_pretty(value).unwrap()
    } else {
        serde_json::to_string(value).unwrap()
    };
    out.push_str(&s);
    out.push('\n');
}

/// Parse one `--attr key=value` argument.
pub fn parse_attr(arg: &str) -> Result<(String, String), u8> {
    match arg.split_once('=') {
        Some((k, v)) => Ok((k.to_string(), v.to_string())),
        None => {
            eprintln!("otelite: --attr expects key=value, got {arg}");
            Err(EX_USAGE)
        }
    }
}
