# 0017 — Adapter consumes a structured source; otel-scrape owns presentation

Status: accepted

**Context:** The adapter admission policy (decision 0012) already requires a
machine-readable Source ("Human logs are degraded fallback only"). Two problems
surfaced when oxlint (the only adapter exercised on the devenv path; 0012 also
ships node-cpuprofile) was run on the real devenv
path (experiment `.experiments/0008-adapter-structured-source-contract.md`):

1. **UX regression.** oxlint's structured source is `--format=json`, which
   _replaces_ its human diagnostics on stdout. Today the wrapper tees the child's
   raw stdout to the terminal while parsing a captured copy, so instrumenting
   `lint:check:oxlint` prints a JSON object instead of readable diagnostics.
2. **Reliability of the fallback.** The "human logs as degraded fallback" clause
   invites fragile scrapers. The devenv tsc timing scraper's regex
   `([0-9]+\.[0-9]+)s` silently drops `Total time: 12s` (whole seconds) and
   `0,50s` (locale drift), must special-case tsgo-vs-tsc output divergence, and
   maintains a ~25-prefix blocklist that has to track the compiler's output
   surface exactly.

A real-probe capability survey found a clean split: some tools expose a stable
structured format (oxlint `--format=json`; vitest `--reporter=json` +
`--outputFile.json`; cargo `--message-format=json`), some expose only a file-set
list (oxfmt `--list-different`), and some expose no per-diagnostic machine format
at all (tsc/tsgo, vite, storybook). A Rust prototype (isolated fork
`schickling-assistant/2026-07-02-m4-adapter-render`, lib.rs +76/-1) demonstrated
otel-scrape can consume the structured source and re-render a human summary to
the terminal (`oxlint: 2 diagnostic(s) over 1 file(s)` + per-diagnostic lines),
UX-neutral, while the OTLP export stayed byte-clean (severity + hashed filename
only).

**Decision:** A release adapter MUST consume a **declared, stable, structured
source**, and otel-scrape OWNS re-presentation so instrumenting never degrades
the terminal. Concretely:

1. **Structured source, declared.** Each adapter names the tool, the exact format
   flag(s) it requires, and the schema it parses. No release adapter parses a
   tool's default/pretty/human output. This sharpens the 0012 Source gate:
   human-text parsing is NOT part of an adapter — it is, at most, a clearly
   labeled best-effort scraper that lives _outside_ the adapter contract and is
   never presented as a supported adapter.
2. **Who adopts the format flag — split by adapter shape.** For a **needs-render**
   adapter (oxlint) the call-site passes the format flag (`--format=json`): the
   structured format replaces the tool's stdout, so the flag is part of
   instrumenting the command, not an otel-scrape default. For a **side-channel**
   adapter (vitest) otel-scrape MAY own and inject the side-channel flags itself
   (`--reporter=json --outputFile.json=<tmp>`) for the CLOSED, known adapter set,
   because the flags are mechanical and the human stdout is unaffected — PROVIDED
   it (i) respects any user-supplied `--outputFile.json`/`--reporter` (reads the
   user's file in place and never deletes it; preserves the user's human reporter
   and only adds `--reporter=json` alongside; injects `--reporter=default` only
   when the user passed no reporter) and (ii) degrades **non-silently**: on a
   missing/empty/unparseable side-channel file it warns on stderr and OMITS the
   metrics rather than emitting a misleading `tests=0 / failures=0`. This is the
   actual, better design — the impl injects for vitest under these guards; the
   original "call-site passes it, not an otel-scrape default" wording held only for
   the needs-render (oxlint) path and is narrowed to it here.
3. **Presentation ownership (UX-neutral).** When the structured format replaces
   the tool's human stdout, the adapter MUST re-render a readable summary to the
   terminal (severity/file/rule/count). Where the tool offers a **side-channel**
   (structured to a file/fd while human output stays on stdout, e.g. vitest), the
   adapter MUST prefer it and NOT re-render. Rendering lives in otel-scrape,
   per-adapter — never at the call-site. (requirement R30)
4. **Privacy holds (R27, decision 0015).** Telemetry sinks stay public-safe: raw
   argv/cwd gated per trusted-sink; diagnostic **messages dropped**, filenames
   **hashed** in OTLP and in the local summary. The terminal render MAY show full
   messages/paths (it is the operator's own machine, not a sink). This closes the
   observed gap where the local summary stored the raw diagnostic message.
5. **No structured source ⇒ no adapter.** A tool without a stable structured
   format is not adapter-eligible; it stays uninstrumented, `adapter=none`
   (named-command identity only), or a labeled best-effort scraper — never
   promoted to an adapter.

**Tool mapping (from the survey):**

| Tool                    | Status under this contract                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| oxlint                  | adapter-eligible now · `--format=json` · needs-render                                                                                                                                      |
| vitest                  | adapter-eligible now · `--reporter=json --outputFile` · side-channel (no render)                                                                                                           |
| cargo                   | adapter-eligible now · `--message-format=json` · needs-render                                                                                                                              |
| oxfmt                   | limited · `--list-different` · file-set/count adapter only                                                                                                                                 |
| tsc / tsgo              | deferred · no structured _diagnostics_ source; the `--generateTrace` _phase_ artifact remains the deferred profile-adapter path (0012), distinct from the current best-effort text scraper |
| vite / storybook / pnpm | deferred · no per-diagnostic structured source                                                                                                                                             |

**Consequences:**

- Refines **0012 (adapter admission):** the Source gate becomes concrete and
  testable — an adapter PR declares its format flag + schema and ships a
  re-render (or uses a side-channel), plus privacy + degraded-mode tests.
- Refines **0002 (leaf owns adapter parsing):** the leaf owns parsing AND
  re-presentation; the split from raw-passthrough is the substantive change.
- The oxlint raw-JSON tee is superseded by structured-in/pretty-out; the existing
  `oxlint_adapter_parses_json_diagnostics_without_hiding_stdout` test is replaced
  by a render + privacy test. Pretty-out composes through re-entrancy (an outer
  wrapper captures the inner's rendered summary — human text, not reparseable
  JSON, so leaf-ownership per 0002 holds).
- Each new needs-render adapter adds a small renderer in otel-scrape (bounded by
  the 0012 admission gate). Side-channel adapters add none.
- The summary-sink message field is dropped/gated to preserve public-safety.

**Options considered:**

| Option                                                                    | Consequence                                                                                                                | Verdict                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Raw-JSON passthrough (status quo)                                         | tees structured output to the terminal; instrumenting degrades UX.                                                         | rejected — the reported problem.                          |
| Usage-site pretty-pipe (`tool --format=json \| prettifier` per call-site) | keeps otel-scrape dumb but pushes a prettifier into every call-site → drift, defeats concise instrumentation.              | rejected — moves the burden to the sites we want concise. |
| No adapters (identity only)                                               | `adapter=none` everywhere: named command spans, no diagnostics/metrics.                                                    | rejected — discards the real signal adapters carry.       |
| Structured-source + otel-scrape re-render, side-channel preferred         | reliable parsing, UX-neutral terminal, concise call-sites, privacy preserved; cost = one renderer per stdout-only adapter. | accepted                                                  |

Grounded by `.experiments/0008-adapter-structured-source-contract.md`. Refines
[.decisions/0012-adapter-admission-policy.md](./0012-adapter-admission-policy.md)
and [.decisions/0002-leaf-wrapper-owns-adapter-parsing.md](./0002-leaf-wrapper-owns-adapter-parsing.md).
