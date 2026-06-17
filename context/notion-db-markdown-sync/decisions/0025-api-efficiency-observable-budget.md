# API efficiency: rate-limit discipline enforced by an observable budget

Status: accepted

API resourcefulness and rate-limit discipline are a first-class NFR, not a
best-effort aspiration. This record decides to enforce them via an OBSERVABLE
budget rather than a principle, a doc note, or a hard fail-closed guard. The
budget has two halves that answer two distinct questions.

## Half 1 — call-count budget (`@overeng/notion-datasource-sync`)

Every `notion.api.request` span already carries an endpoint attribute
(`spanAttr.operation`). On the strength of that attribute, add falsifiable
call-count CEILING assertions on key paths in `otel.e2e.test.ts` by counting
`notion.api.request` spans under the sync/pull/push span. This is proven
feasible: a clean one-shot issues exactly 5 — `preflightCapabilities`,
`retrieveDataSource`, `queryRows`, `listDataSourceViews`, `retrievePage`. The
assertions live test-side. Optionally, production `request_count` metrics are
emitted via `OtelMetric.effect.counter`.

## Half 2 — rate-limit discipline (`@overeng/notion-effect-client`)

Instrument `rate_limit_wait_ms` — the time blocked waiting for a throttle token —
at the `NotionThrottle.apply` seam. Surface retry and `retry-after` signals
(already partly emitted on `NotionHttp.*` spans) as first-class signals plus
`OtelMetric` counters. Add a FAULT-INJECTING HTTP stub so the rate-limit half is
deterministically testable without live Notion: the fake gateway never exercises
the HTTP path, so it emits zero rate-limit signals and gives no CI coverage on
its own.

## Count semantics

The budget CEILING counts LOGICAL requests — one `notion.api.request` span. It
answers "did we design an efficient access pattern". HTTP-attempt count and wait
time are SEPARATE rate-limit-pressure signals; they answer "what did rate-limit
pressure cost us". The two diverge precisely under load — retries and throttle
waits multiply HTTP attempts and wait time while the logical-request count holds
steady — which is exactly when the budget matters. Stating the distinction is
what keeps the budget falsifiable: a ceiling on logical requests is not silently
inflated by retry storms.

## Metrics routing

All metrics route through `@overeng/otel-contract` `OtelMetric`. The
`overeng/no-raw-otel-primitives` lint bans raw Effect `Metric` in `src/**`; e2e
tests are exempt.

## Evidence

A validation agent confirmed the endpoint attribute already ships, proved
test-side call-count ceilings work (the 5-request one-shot, counted by
operation), located the limiter and the retry/rate-limit observability in
`@overeng/notion-effect-client` (throttle-wait is the one genuinely-new signal
and must be instrumented at `NotionThrottle.apply`), confirmed the `OtelMetric`
bridge and the lint constraint, and flagged that fake-vs-live divergence means
rate-limit signals need a fault-injecting stub for CI.

## Considered Options

| Option                                                 | Result   | Reason                                                                                                 |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| Principle/doc only                                     | Rejected | "Efficiency is a defect if violated" stays unmeasured; regressions slip in silently.                   |
| Requirement + hard fail-closed budget guard            | Rejected | Risks blocking legitimate bursts/backfills; needs budget calibration plus a new guard.                 |
| Requirement + observable budget (both halves)          | Selected | Falsifiable ceilings catch regressions without false blocks; rate-limit signals give fleet visibility. |
| (scope) call-count half only, rate-limit half deferred | Rejected | The rate-limit visibility is the explicitly-requested signal.                                          |
| (scope) both halves, rate-limit live-test only         | Rejected | No deterministic CI coverage for the rate-limit half.                                                  |
| (scope) both halves with fault-injecting stub          | Selected | Full visibility plus deterministic test coverage.                                                      |

## Consequences

- Cross-package change: `@overeng/notion-datasource-sync` (call-count ceilings,
  optional `request_count`) and `@overeng/notion-effect-client` (throttle-wait,
  retry/`retry-after` signals).
- New fault-injecting HTTP stub test infrastructure so the rate-limit half has
  deterministic CI coverage rather than depending on live Notion.
- The logical-vs-HTTP-attempt distinction must be stated in the requirement so
  the budget stays falsifiable — a logical ceiling must not be conflated with
  HTTP-attempt count.
- Ties to the new efficiency requirement.
