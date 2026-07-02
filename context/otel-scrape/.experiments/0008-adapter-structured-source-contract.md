# Experiment 0008 — adapter structured-source + presentation

Evidence for [decision 0017](../.decisions/0017-adapter-structured-source-and-presentation.md).
Question: which tools expose a stable structured source, and can otel-scrape
consume it while keeping the terminal UX-neutral (re-render or side-channel)?

## Method

Real-probe capability survey of the tools the repo runs (run each binary, inspect
output + flags). A Rust prototype in an isolated fork
(`schickling-assistant/2026-07-02-m4-adapter-render`, `branchy fork`, archived
after; lib.rs +76/-1) suppressing the raw-JSON tee for a presenting adapter and
calling a per-adapter re-render. Captures to dev3 Tempo; OTLP payload byte-grepped
for leaks.

## Findings

1. **Capability matrix.** STRUCTURED-READY now: **oxlint** (`--format=json`,
   replaces stdout → needs re-render), **vitest** (`--reporter=json
--outputFile.json` → side-channel: pretty stays on stdout, JSON to file,
   UX-neutral by construction), **cargo** (`--message-format=json`, NDJSON →
   needs re-render). oxfmt = `--list-different` (file-set/count only). tsc/tsgo,
   vite, pnpm, storybook = no per-diagnostic machine format (tsgo `--help` → 0
   json flags).
2. **Pretty-out works.** The rebuilt prototype turned raw JSON on the terminal
   into `oxlint: 2 diagnostic(s) over 1 file(s)` + per-diagnostic lines, while the
   adapter events still landed in Tempo (`a5cfafd1…`) and the OTLP export stayed
   byte-clean (grep for the message/`bad.ts` = 0; severity + hashed filename
   only). Rendering belongs IN otel-scrape (~50 lines for oxlint), and composes
   through re-entrancy (an outer wrapper captures the inner's rendered summary).
3. **Reliability contrast (tsc).** The devenv `--extendedDiagnostics` scraper's
   regex `([0-9]+\.[0-9]+)s` drops `Total time: 12s` (whole seconds) and `0,50s`
   (locale), needs tsgo-vs-tsc special-casing, and a ~25-prefix blocklist. No
   structured alternative for diagnostics exists → tsc stays best-effort scrape,
   not an adapter.
4. **Privacy gap found.** OTLP drops the diagnostic message and hashes the
   filename, but the local **summary** still stored the raw `message`. The
   contract drops/gates it under the R27 / decision 0015 model.

## Verdict

An adapter MUST consume a declared stable structured source and otel-scrape
re-presents it (or uses a side-channel), so instrumenting is reliable AND
UX-neutral; privacy holds. Unlocks now: oxlint, vitest, cargo. tsc deferred.

Findings detail: `tmp/vista-issue866/m4-adapter-contract-experiment.md`
(gitignored). Trace id: prototype export `a5cfafd142493180096512ae02ea29e0`.
