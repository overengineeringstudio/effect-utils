# 0014 - Command identity, span naming, and trust-gated raw evidence

Status: accepted

## Context

First-party devenv validation surfaced that `otel-scrape` traces are dominated
by semantically empty spans. In a real 138-span `devenv check:all` trace, 76 spans (55%) were
generic `otel_scrape.command` / `otel_scrape.process` pairs — every one named by
a fixed instrumentation constant, carrying no command identity beyond a
`sha256` argv hash, `exit_code`, and `adapter.name = none` under a
`direct-child` / `degraded` process observation. The waterfall is an unreadable
wall of identical `otel_scrape.command` rows, and the only meaningful spans
(`devenv.task.exec`, `typescript.project.check`) are buried under them.

Two root causes: (1) the span **name** is the instrumentation
(`otel_scrape.command`), not the operation, so no command is distinguishable;
(2) the degraded direct-child backend emits a redundant `otel_scrape.process`
span that duplicates the command span. A further constraint governs how far
identity can be surfaced: requirement R27 kept all evidence "public-safe" by
hashing argv/cwd, because `otel-scrape` is a reusable public substrate whose
default must be safe for any adopter's sink.

Evidence: [../.experiments/0005-command-identity-and-noise.md](../.experiments/0005-command-identity-and-noise.md).

## Evidence and Argument

- The executable **basename** (`tsc`, `vitest`, `cargo`) is a public-safe
  identity — it is not a path, args, or secret — and an e2e probe confirmed it
  can name the span without surfacing raw argv. Naming a span by its operation
  is standard OpenTelemetry practice; the registry can own the naming _scheme_
  rather than a fixed command span-name string.
- The argv hash is not only a privacy device: it is the stable
  correlation/dedup key (same command → same hash across runs), which raw argv is
  too noisy to be. So identity is additive (basename + hash), not a swap.
- The degraded `direct-child` process span carries the same argv hash and exit
  code as the command span plus three observation attributes — near-redundant.
  A distinct process span carries real signal only under an exact backend that
  proves a descendant tree.
- Full argv/cwd is genuinely useful for debugging and is insensitive in a
  private, access-controlled sink. But raw-by-default would leak argv/paths the
  moment any adopter points OTLP at a shared/cloud backend — a footgun baked into
  the default of a public-substrate tool. An explicit, per-sink, off-by-default
  trust assertion delivers the richness without the default footgun.
- Credentials, source text, and child output payloads are a different category
  from identity: a credential in telemetry is an antipattern regardless of sink
  trust, and payloads can carry anything. They stay excluded even under trust.

## Options

| Option                                                                          | Consequence                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep generic `otel_scrape.command` name + argv hash (status quo)                | Stable, but the waterfall stays an unreadable wall of identical spans; no command is distinguishable without dereferencing a hash.                                        |
| Name spans by program basename; keep everything else hashed (no privacy change) | Readable waterfall with zero R27 change and no trust mechanism; but no raw argv for deep debugging — hash + adapters only.                                                |
| Name by basename + trust-gated raw argv/cwd (chosen)                            | Readable by default and fully debuggable when a sink is asserted private; preserves the safe-anywhere substrate default. Cost: relax R27 and build a per-sink trust gate. |
| Raw argv by default                                                             | Simplest and fully readable, but leaks argv/paths to any shared/cloud sink by default; breaks the public-substrate property.                                              |

## Decision

**Span naming.** A span is named by the operation it represents, never by the
instrumentation. Command spans are named by the wrapped program's basename;
process spans by the observed descendant program basename; tool-phase spans by
the adapter phase. `otel-scrape` ownership moves to `otel.scope.name =
otel-scrape` and `span.origin = otel-scrape` (`otel-scrape-adapter` for phase
spans). The generated telemetry registry owns the naming _scheme_, scope
identity, and attribute keys — not a fixed command span-name string (amends
0004). Where `otel-scrape` wraps a command already inside another
instrumentation's task span, the two cooperate: the task instrumentation owns
the task level and `otel-scrape` owns command/process/tool-phase beneath it.

**Process merge.** In the default degraded `direct-child` backend the process
observation is merged into the command span
(`otel_scrape.process.observation.fidelity = "merged"`); a distinct process span
is emitted only under an exact backend that proves a real descendant.

**Trust-gated identity (relaxes R27).** Every sink is public-safe by default:
`command.program` (basename), `command.argv_hash`, and `command.cwd_hash` are
always present. Raw `command.argv`/`command.cwd`/local paths are emitted only
into a sink an operator explicitly asserts private
(`OTEL_SCRAPE_TRUSTED_SINK` / `--trusted-sink`) — explicit, per-sink, off by
default. Credentials are never emitted to any sink; source text and child output
payloads stay descriptor-only (the spec `OutputDescriptor`) regardless of trust.

## Consequences

- The span-name model change ripples to `telemetry-registry.json` (the fixed
  command/process span-name constants become the naming scheme; `command.*`,
  `span.origin`, `otel.scope.name` are added; `process.command_args_hash` is
  renamed to `command.argv_hash`) — regenerate into Rust/TypeScript. Recorded as
  an implementation delta.
- Any test that asserts the command span name equals the literal
  `"otel_scrape.command"` must be updated to assert the naming scheme
  (basename + `span.origin = otel-scrape`).
- Requirements R27 (public-safe → trust-gated), R01, and R05 are amended.
- Traces become readable by default (a real `check:all` collapses from 138 spans
  to ~62 meaningful ones) while the concrete-command level is preserved.
- New mechanism to build: the per-sink trust assertion. Its exact granularity
  (global boolean vs per-endpoint allowlist) is open (spec DQ2).
