# Semantic Conventions — Open Questions

Unresolved design questions. Each links a spec `DQ`. Questions leave this file when
resolved — into the spec as decisions (marked `RESOLVED` in [spec.md](./spec.md) §Design
Questions) or into `.experiments/` as tested hypotheses. SC-DQ1, SC-DQ2, SC-DQ5, and SC-DQ6
have exited (all resolved; see the spec's Design Questions and `.decisions/0002`–`0005`).

## SC-DQ3 — Where does privacy / metric-label enforcement live?

**Question:** Beyond identity, should a gate reject high/unbounded/secret attributes used as
metric labels (a metric-label / privacy policy)? Is that mechanism (this subsystem) or
policy (a consumer's own semantic contract)?

**Resolves when:** reconciled with the consumer's contract owner.

## SC-DQ4 — Weaver / semconv version compatibility matrix

**Question:** What is the update cadence and compatibility matrix between pinned Weaver,
pinned upstream semconv (`@vX.Y.Z[model]`), and the emitted schema?

**Evidence so far:** weaver 0.24.2 `--future` is clean with semconv v1.37.0; ≤v1.36 fail on
their own unstructured-`deprecated`. The flake carries a single-command refresh recipe for
the pinned upstream FOD. Pre-1.0 Weaver CLI/resolved-schema may churn; v1 `groups:` input is
the stable contract.

**Resolves when:** a version-bump runbook + a CI smoke test exist.

## Non-VRS follow-up — amend the earlier downstream design note

Not a design question — a constitutional edit in a downstream consumer's own (private) repo.
An earlier note there ("registry authored in Weaver YAML") must be amended to reflect
TS-first authoring (see [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md)).
Requires user sign-off; tracked as a separate action, not owned by this VRS.
