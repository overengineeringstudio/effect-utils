# Prototype validation

Non-normative evidence for [../spec.md](../spec.md) and
[../.decisions/0001-two-lane-explicit-bridge.md](../.decisions/0001-two-lane-explicit-bridge.md).
Validated end-to-end in an isolated worktree against the real harness (not a
throwaway), Vitest pinned `4.1.9`.

## Question

Can Vitest's native OpenTelemetry runner tree and Effect product spans compose
without global-provider coupling or loss of deterministic otelite assertions?

## Method

Run the real utils-dev harness with Vitest `4.1.9`, a minimal native SDK, and
otelite capture; compare the emitted runner/product trace relationships with
the bridge enabled, suppressed, and absent.

## Result

| Hypothesis                                         | Method                                                                              | Result                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Vitest native OTEL emits a useful runner tree      | minimal sdkPath (no auto-instrument), capture spans                                 | `worker→runtime→runner→test.callback` + transform/collect/coverage; ~50 spans/run |
| Effect spans do NOT auto-nest under the runner     | read `OtlpTracer` source                                                            | confirmed: imports only `effect/*`, parents from Effect parent only               |
| Explicit bridge nests product spans                | seed `withParentSpan(makeExternalSpan(getActiveSpan()))` through real `withTestCtx` | product spans carry Vitest's **exact traceId** — impossible by chance             |
| Suppression keeps the assertion lane deterministic | run otelite tests with native OTEL on                                               | **4/4 pass**, 157 runner spans emitted same run                                   |
| Change is inert when native OTEL off               | `bridgeVitestParent` returns `self` when no active span                             | utils-dev suite 31/31, otelite baseline 4/4                                       |

## Regression gates (raw binaries, bypassing the FOD-blocked devenv shell)

- `tsc -b` full workspace: **0 errors**.
- oxlint on the 6 changed files: **0 warnings / 0 errors**; oxfmt clean.
- `@overeng/utils-dev` full suite (harness lives here): **31/31 pass**.

## Conclusion

The explicit bridge connects independent runner and product providers, while
the suppression marker keeps assertion capture deterministic. Native runner
telemetry remains inert when collector context is absent.

## VRS Impact

- Adding `@opentelemetry/exporter-trace-otlp-http` changed `pnpm-lock.yaml`,
  invalidating the nix pnpm-deps FOD hashes for workspace CLIs (oxc-config,
  notion-cli, …). Requires a one-time Evergreen `fod chase-fod-closure`; until
  then the full `devenv check:all` shell will not build (substance validated via
  raw binaries instead).
- The harness's own `Layer.span` per-test root span was not observed in the
  export capture — spec DQ2.
- `.integration.test.ts` files fail when run outside the devenv test task (they
  need git-remote / restate-server setup); unrelated to this change.
