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
   native root (devenv when it ships usable OTLP, coding-agent runtimes), join it
   rather than wrapping it. The floor does not compete with a real native root.
3. **`otel-wrap` floor.** Where no ambient context and no principled native root
   exist, `otel-wrap` mints the root. It is the always-available floor, deployable
   in agent bash, CI, and plain shells.

The highest participant in the causal chain owns the root; nested participants
join; exactly one participant surfaces the trace. This inverts the earlier
native-devenv-first stance: the floor is universal and available now, and native
OTEL is embraced where principled rather than depended on as the only root.

**Consequences:**

- Coverage is universal and not gated on any one runtime's native tracing.
- Coding-agent commands nest for free (they self-root), so agent workloads join
  without special handling.
- Native `devenv --trace-to` becomes a later optional upgrade the model already
  admits under rule 2, not a blocker.
- The precedence is owned once by `otel-core` (mint/join precedence primitive)
  and consumed by every bin.
