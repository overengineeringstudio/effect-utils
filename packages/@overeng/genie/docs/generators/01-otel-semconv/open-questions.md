# Semantic Conventions — Open Questions

Unresolved design questions. Each links a spec `DQ`. Questions leave this file when
resolved — into the spec as decisions (marked `RESOLVED` in [spec.md](./spec.md) §Design
Questions) or into `.experiments/` as tested hypotheses. SC-DQ1, SC-DQ2, SC-DQ4, SC-DQ5, and
SC-DQ6 have exited (all resolved; see the spec's Design Questions, `.decisions/0002`–`0005`,
and the [version-bump runbook](./version-bump-runbook.md)).

## SC-DQ3 — Where does privacy / metric-label enforcement live?

**Question:** Beyond identity, should a gate reject high/unbounded/secret attributes used as
metric labels (a metric-label / privacy policy)? Is that mechanism (this subsystem) or
policy (a consumer's own semantic contract)?

**Resolves when:** reconciled with the consumer's contract owner.

## Non-VRS follow-up — amend the earlier downstream design note

Not a design question — a constitutional edit in a downstream consumer's own (private) repo.
An earlier note there ("registry authored in Weaver YAML") must be amended to reflect
TS-first authoring (see [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md)).
Requires user sign-off; tracked as a separate action, not owned by this VRS.
