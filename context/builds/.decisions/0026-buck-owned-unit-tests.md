# 0026 Buck-Owned Unit Tests

Status: accepted

## Context

Test execution is the largest workload with no Buck path on any roadmap
phase: 57 runner-minutes per CI run across the vitest lanes and the biggest
local compute surface. Unit tests look bounded and deterministic — exactly the
class BUCK-R01 claims — yet stayed legacy by omission, leaving the
sole-producer boundary undefended. Caching unchanged-package test runs is the
largest remaining cache win after TypeScript widening.

## Evidence and Argument

CI run #5142 job timings put the vitest lanes at 57 runner-minutes per run;
vision success criteria 1 and 2 (irrelevant mutation executes nothing; second
context re-executes nothing) apply to test execution verbatim. Counterpoints
considered: the integration and live-deploy lanes are genuinely unbounded and
side-effectful, and vitest-under-Buck hermeticity has never been exercised in
this repository. Johannes resolved the structured question on 2026-09-01:
admit unit tests rather than recording them as permanently legacy or deferring
without commitment.

## Options

| Decision  | Selected                      | Alternatives rejected                                                                                                                          |
| --------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Test lane | Admit unit tests, spike-gated | Permanent-legacy (caps cache value; the "unit tests are unbounded" claim is itself ungrounded); defer-with-trigger (boundary stays undefended) |

## Decision

Unit-test execution becomes Buck-owned. The gate is a hermeticity spike: one
package's vitest suite as a Buck action, checking determinism, tmp/network
isolation, and cache-key stability. After the spike passes, a roadmap phase
sequences per-package test admissions following the first Phase-3
admissions, each deleting its devenv test-batching edge in the same change
(BUCK-R09). The integration, live-deploy, and browser lanes are explicitly
legacy: they are unbounded and stay outside Buck by policy.

## Consequences

- The BUCK-R01 boundary becomes defended: bounded deterministic test execution
  is inside, unbounded execution is explicitly outside.
- genie projects test targets the same way it projects typecheck targets; the
  rule surface grows by one test-runner rule.
- Each admission's deletion-ledger entry must show the removed devenv edges,
  and BUCK-R15 accounting covers the added rule surface.
- A failed spike reopens the question with evidence; the direction costs only
  the spike until then.

## Amendment 1 — Cacheable Verdict Build Actions

Axe record `ecwtsb` selects cacheable Buck build actions producing a typed
pass/fail result and structured report. Pinned Buck2 `be6971d4` never uploads
local test executions (`orchestrator.rs:1533–1538`), so that orchestration cannot
satisfy the unchanged-input reuse claim.
[Issue #1600](https://github.com/overengineeringstudio/effect-utils/issues/1600)
tracks implementation and proof. The unit-test admission goal is unchanged.
[Execution](../04-buck2/05-execution/spec.md#cacheable-unit-test-verdict-actions) owns
the mechanism; [reuse](../04-buck2/06-reuse-client/spec.md#action-reuse-versus-verdict-reuse)
proves action reuse separately from verdict reuse. Historical BUCK-R06/EXEC-R07/
REUSE-R02 resolve through the [ID map](../.reference/id-map.md).
