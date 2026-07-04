# Vision: otel-scrape

## The Problem

- **Problem 1 — Build and development tools are observability black boxes:** Many tools expose the phases that cost time only through tool-specific output or profile artifacts. Without a shared wrapper and contract, operators cannot query one coherent trace for compile phases, type checking, plugin transforms, test execution, or lint work.
- **Problem 2 — One logical workload lacks one trace tree:** A local command, package script, or CI step often fans out across subprocesses and nested tools. Today causation is reconstructed from timestamps, logs, and artifact names instead of being visible as `command -> process tree -> tool phase`.
- **Problem 3 — Generic log-to-trace conversion is fragile:** English log lines are incomplete, buffered, reordered, and unstable. Treating every log line as a span creates noisy telemetry that breaks as soon as a tool changes its output.
- **Problem 4 — Native profile artifacts are disconnected from spans:** The deeper answer often lives in `trace.json`, `cpuprofile`, `pprof`, self-profile data, or timing artifacts. Those artifacts are useful only when the span that produced them links to them.
- **Problem 5 — effect-utils already owns pieces of the contract, but not the wrapper:** `@overeng/otel-contract`, `@overeng/utils` command helpers, and `@overeng/content-address` cover validation, command execution, and artifact identity. The missing piece is a reusable CLI/tool contract that combines those pieces into a process-observation surface.

## The Vision

- `otel-scrape <cmd>` wraps a command, owns authoritative lifecycle spans from facts it controls, and preserves passthrough behavior. It is the source of truth for command timing, exit status, resource facts, and subprocess structure. (Problems 1, 2)
- Tool adapters derive structure from each tool's machine-readable output where available. Unstructured lines become events by default; adapters promote records to spans or metrics only when the source carries lifecycle or measurement structure. (Problems 1, 3)
- Trace stitching uses only W3C context propagation. The highest participant in the causal chain mints the root, and nested `otel-scrape` invocations join it. (Problem 2)
- Native profiles are linked, not flattened. The producing span carries a content-addressed descriptor that points to the artifact. The trace shows where to look; the profile explains why. (Problem 4)
- effect-utils provides the reusable public substrate: semantic conventions, typed OTEL values, command-wrapper behavior, artifact descriptors, and adapter contracts that downstream tools can adopt without inventing another schema. (Problem 5)

## What This Is Not

- Not a generic "logs to traces" platform.
- Not a profiler or profile viewer.
- Not a build system, package manager, evaluator, or scheduler.
- Not a daemon or host-wide tracer.
- Not a dashboarding or alerting system.
- Not a second telemetry schema alongside `@overeng/otel-contract`.

## Success Criteria

1. A tool with structured output can be observed by adding one adapter without changing the wrapper core.
2. A wrapped command produces one queryable trace tree spanning command lifecycle, subprocesses, and adapter-derived tool phases.
3. Nested wrapped commands join the same trace through context propagation without post-hoc stitching.
4. Profile-producing tools attach content-addressed descriptors to the producing span.
5. Bare output lines classify as events by default; spans and metrics appear only when the adapter source justifies them.
6. Telemetry-disabled mode remains a transparent command passthrough.
