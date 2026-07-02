# Requirements: otel-scrape

## Context

- Builds on [vision.md](./vision.md).
- Builds on existing effect-utils packages:
  - `@overeng/otel-contract` for typed span, metric, event, and attribute values.
  - `@overeng/utils` command and telemetry helpers for process execution and OTEL setup.
  - `@overeng/content-address` for artifact digest and descriptor conventions.
- The CLI name is `otel-scrape`.

## Assumptions

- **A01 Tools expose structured sources:** The first useful adapters target tools with machine-readable output or profile artifacts, such as JSON reporters, timing files, event logs, trace files, and pprof/cpuprofile output.
- **A02 OTEL conventions are the cross-language contract:** Different emitters can interoperate when they conform to the same span names, attribute keys, metric names, and artifact descriptors.
- **A03 Wrapping is opt-in:** Workloads produce this telemetry only when launched through `otel-scrape` or through a command helper that conforms to the same contract.
- **A04 An orchestrator may mint the root:** A higher-level runner can inject a W3C `traceparent` into each action. `otel-scrape` does not require one; absence means it roots locally.
- **A05 Artifacts do not belong in the OTEL backend:** Spans and metrics go to OTEL backends. Large native profile files go to content-addressed storage and are linked from spans.

## Acceptable Tradeoffs

- **T01 Curated adapter set:** Adapters are first-party and reviewed, not an arbitrary plugin ecosystem. This trades open extension for predictable telemetry quality.
- **T02 Events before spans:** Adapters start conservative. A record becomes a span only when the tool source provides stable identity and lifecycle boundaries.
- **T03 Artifact lane beside sampled profiling:** Content-addressed native profiles and sampled/continuous profiling can coexist. `otel-scrape` owns the artifact lane.
- **T04 Contract before implementation:** The VRS establishes the public contract before package boundaries and runtime implementation are finalized.
- **T05 Privileged observation is split from wrapping:** Exact process observation may require an installed helper, but the normal `otel-scrape` wrapper stays unprivileged and transparent. This trades deployment complexity for lower workload perturbation.
- **T06 Capability-gated exactness:** Release support may be exact on one platform class and degraded on another when the degraded platform lacks a validated exact event source. This trades uniform feature labels for truthful telemetry.

## Requirements

### The wrapper is the source of truth

- **R01 Wrapper-owned lifecycle span:** Every `otel-scrape <cmd>` invocation produces a command span from facts the wrapper controls: a public-safe command identity (the executable basename), stable argv and cwd hashes (retained as correlation keys), start/end/duration, exit code, tool name/version when available, and captured-output descriptors. Raw argv/cwd are trust-gated (R27).
- **R02 Resource facts:** The command span records resource usage available without privileged host tracing, at minimum process CPU time and max RSS where the platform exposes them.
- **R03 Passthrough fidelity:** The wrapped tool's stdout, stderr, and exit code are preserved so `otel-scrape <tool> ...` can replace `<tool> ...` in scripts.
- **R04 Disabled-mode transparency:** With no configured OTEL export target, the command still runs and no telemetry is emitted.

### Subprocess trees

- **R05 Process-tree spans:** Observable child processes carry a public-safe process identity (the executable basename) and stable argument hashes. A distinct process span is emitted only under an exact backend; the default degraded direct-child observation is merged into the command span (spec: Process-Tree Fidelity).
- **R06 Nested join:** A wrapped tool that invokes `otel-scrape` again joins the same trace through context propagation.

### Adapter contract

- **R07 Adapter interface:** A tool adapter has a fixed contract: detect whether it applies, prepare child environment, consume streamed output, consume structured artifacts, and finalize rollups at process exit.
- **R08 Structured sources required:** A release adapter derives spans, events, metrics, and profile links from a declared, stable, structured source (a named format flag and schema). Parsing a tool's default/human output is not part of an adapter — at most a clearly-labeled best-effort scraper outside the adapter contract (decision 0017).

### Event / span / metric classification

- **R09 Events by default:** A timestamped output line with no lifecycle structure maps to an event on the current span.
- **R10 Promotion rules:** A record maps to a span only when it has a start/end boundary or stable duration-bearing identity. A record maps to a metric only when it is a counter, gauge, histogram sample, or aggregate statistic.
- **R11 No span inflation:** The adapter API makes event/span/metric/profile outputs distinct so adapters cannot accidentally turn every line into a span.

### Context propagation

- **R12 Root-or-join:** If no parent context exists, `otel-scrape` mints a root. If a W3C `traceparent` exists, it joins that trace.
- **R13 Child context export:** The wrapper exports active context to child processes so context-aware children and nested wrappers join the same tree. The wrapper exports its command-span context as both `TRACEPARENT` and `OTEL_TASK_TRACEPARENT`, so a task-parented sub-span emitter re-parents under the `otel-scrape` command span rather than binding to an outer task span (decision 0018).
- **R14 Highest-minter rule:** The highest participant in the causal chain owns the root. A local command roots locally; an orchestrator roots once and injects context per action.
- **R15 Enrichment-not-tree:** Context known only to one participant attaches as attributes on that participant's span, not as a second trace tree.

### Artifact linking

- **R16 Link, don't flatten:** Native profiles are never encoded as span trees. The producing span carries a descriptor with profile type, digest, URI, and optional UI link.
- **R17 Content-addressed retrieval:** Profile artifacts are stored content-addressed and are integrity-verifiable from the descriptor.

### effect-utils integration

- **R18 One logical schema:** `@overeng/otel-contract` remains the typed validation/encoding layer for OTEL values. `otel-scrape` conforms to it instead of defining a parallel schema.
- **R19 Shared artifact convention:** `otel-scrape` uses the `@overeng/content-address` digest and path conventions for artifact descriptors.
- **R20 Consumer-agnostic substrate:** Local development, test execution, and CI attribution consume the same emitted trace tree rather than receiving consumer-specific telemetry shapes.

### Exact process observation

- **R21 Release-grade exactness:** A release-grade process-tree claim is platform/backend-specific. A stable release may claim exact descendant process observation only for platform/backend combinations with validation evidence; all other combinations remain explicitly degraded or experimental.
- **R22 Exactness proof:** An exact process backend must observe process creation, exec identity changes, and exit for every included descendant, including short-lived descendants, and must prove parent/child links without sampled `/proc` inference.
- **R23 Downgrade on uncertainty:** Event loss, helper restart, missing privilege, namespace/cgroup ambiguity, unsupported platform mechanisms, version mismatch, or missing lifecycle events must downgrade affected evidence instead of emitting exact spans.
- **R24 Helper boundary:** Default exact observation uses a helper-style event-source boundary that does not perturb the wrapped command. `otel-scrape` must not require ordinary wrapped commands to run with elevated privileges.
- **R25 Contract ownership:** `effect-utils` owns the public process-observation contract: backend selection, helper protocol, schemas, summary evidence, OTLP span semantics, fake-helper fixtures, validation tests, and release documentation.
- **R26 Deployment ownership:** Privileged activation, kernel/Endpoint Security permissions, system service configuration, socket placement, health checks, fleet rollout, and machine-specific policy belong outside the public wrapper contract, initially in the fleet/dotfiles layer.
- **R27 Public-safe by default; trust-gated raw identity:** Every evidence sink (summaries, OTLP export, persistent helper logs) is public-safe by default: it carries a public-safe **program identity** (executable basename — never a full path or args), stable argv/cwd **hashes** retained as correlation keys, and bounded reason codes; raw argv, cwd, and local paths are excluded. An operator MAY explicitly assert a specific sink private **by name** (`--trusted-sink <sink>`; env alias `OTEL_SCRAPE_TRUSTED_SINK` is pinned to the single OTLP target), which permits raw argv/cwd/local paths into **that sink only**; the assertion is explicit, per-named-sink, and off by default (decision 0015). The local summary is public-safe unless the summary sink is itself asserted — an OTLP assertion never covers it. **Credentials are never emitted to any sink**; source text and child output payloads remain descriptor-only (captured-output descriptors, R01) regardless of trust. Trust unlocks identity, not secrets. Adapter-derived records follow the same rule: severity, rule codes, hashed filenames, and counts are public-safe and may be emitted to any sink, but raw diagnostic messages and local paths are payload-derived and remain descriptor-only in every sink **including the local summary** — they may appear only in the operator's terminal render, which is not a sink (decision 0017).
- **R28 Linux cgroup authority:** Linux exact helper mode must use a run-scoped cgroup, or an equivalently strong kernel-owned execution boundary, as the authority for run membership. Process ancestry, process groups, sessions, and wrapper run IDs may enrich correlation but must not be the sole authority for exactness.
- **R29 macOS exactness gate:** macOS ARM support is degraded by default unless an Endpoint Security-backed helper, or an equivalently exact and supported system event source, proves installation, entitlement, user/admin approval, event-loss handling, run correlation, and fixture validation in both a runner environment and the target host class.

### Adapter presentation

- **R30 Adapter presentation is UX-neutral:** When an adapter's required structured format replaces the tool's human stdout, `otel-scrape` MUST re-present a readable summary to the terminal; where the tool offers a side-channel (structured output to a file/fd while human output stays on stdout), the adapter MUST prefer it. Instrumenting a command with an adapter MUST NOT degrade interactive readability. Re-presentation lives in `otel-scrape` (per-adapter), not at the call-site (decision 0017).
