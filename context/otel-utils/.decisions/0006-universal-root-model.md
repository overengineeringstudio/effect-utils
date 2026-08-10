# 0006 — Universal root model

**Status:** Accepted.

**Context:** Not every workload runs under an orchestrator or a build-tool
wrapper. Bare shell commands, coding-agent Bash calls, and CI steps need a way to
participate in one trace tree. An earlier direction (the amended
[otel-scrape decision 0021](../otel-scrape/.decisions/0021-observability-boundary-effect-utils-vs-dotfiles.md))
made native devenv tracing the orchestration root and gated coverage on it — but
that build shipped no usable OTLP output, so coverage was both blocked and
non-universal. Meanwhile coding-agent runtimes already self-root their Bash-tool
commands with a native `traceparent`.

**Decision:** The family adopts a layered universal root model, in precedence
order:

1. **Join ambient `TRACEPARENT`.** If an inbound W3C `traceparent` exists, join
   it — never mint a competing root.
2. **Embrace native OTEL where principled.** Where a producer emits a principled
   native root (current devenv and coding-agent runtimes), join it
   rather than wrapping it. The floor does not compete with a real native root.
3. **`otel-wrap` floor.** Where no ambient context and no principled native root
   exist, `otel-wrap` mints the root. It is the always-available floor, deployable
   in agent bash, CI, and plain shells.

The highest participant in the causal chain owns the root; nested participants
join; exactly one participant surfaces the trace. The floor is universal, but
does not replace a native root where one is available.

**Consequences:**

- Coverage is universal and not gated on any one runtime's native tracing.
- Coding-agent commands nest for free (they self-root), so agent workloads join
  without special handling.
- Native `devenv --trace-to` is the current repository-orchestration path,
  composed with otelite by `devenvModules.observability`.
- The precedence is owned once by `otel-core` (mint/join precedence primitive)
  and consumed by every bin.

## Amendment: native devenv is active

The original context recorded a devenv build that emitted no usable OTLP. That
evidence is obsolete: devenv 2.1.2 exports root, evaluation, and aggregate task
spans, and the shared observability module captures them hermetically. The
remaining upstream gap is narrower: status and execution child activities are
coupled to global debug verbosity. The module retains its compatibility bridge
until [cachix/devenv#3037](https://github.com/cachix/devenv/issues/3037) lands;
this does not change native devenv's ownership of the root.
