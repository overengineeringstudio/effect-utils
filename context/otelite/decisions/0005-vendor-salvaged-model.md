# Reuse a proven trace model/analysis, vendored into otelite (not a shared lib yet)

otelite's `inspect` reuses a proven, conformance-tested OTLP trace
implementation — a span/trace model (SpanRow/TraceSnapshot), an OTLP→model parser
(`parse_otlp_trace`), and a trace summarizer (`summarize_trace` + helpers: slow
spans, exclusive durations, `timing_confidence`) — vendored as **internal otelite
modules**, plus the two relevant conformance goldens. Not extracted to a shared
crate at v1.

## Why reuse (vs reinvent thin)

A prototype detached the core with **zero edits inside the kept functions** (all
backend/query/UI coupling was already isolated behind a fetch boundary the parser
doesn't touch), and the `trace-inspect-basic` + `trace-summarize-json` goldens
pass byte-for-byte. A flatten-only `inspect` would discard ~300 LOC of tested
analysis that makes `inspect` worth more than `jq`, and lose free golden
coverage. The source implementation is being retired, so adapt it now.

## Why vendor (vs shared lib now)

effect-utils' first Rust footprint stays a single bin crate; no public lib API
is frozen before a second consumer's needs are known (a Grafana/Tempo-mediated
query tool may not want this exact OTLP-file path). The seam is already clean, so
promoting to `@overeng/otlp-model` later — if another tool needs it — is
mechanical.

## Contract to preserve

Goldens stay valid only while otelite keeps the model's JSON field set + the
`canonical` serializer. Changing either requires regenerating goldens.
