# 0001: Effect CI Tools Own Deploy Semantics

## Status

Accepted

## Context

The deploy-preview path currently spans generated GitHub workflow snippets, Nix
task modules, shell control flow, provider CLIs, and workflow-report TypeScript.
A Netlify CI failure showed that provider lookup failures can surface as raw
stderr without structured failure records, retry policy, or telemetry that makes
the root cause obvious.

The desired direction is a hard rename from `@overeng/workflow-report` to
`@overeng/ci-tools`, because the package's runtime role is broader than
rendering report comments.

## Decision

`@overeng/ci-tools` is the runtime source of truth for deploy preview behavior.
Generated workflow and Nix task layers stay as thin launchers.

The migration includes Netlify and Vercel provider parity in one PR. Provider
adapters use direct APIs where provider semantics are straightforward and fall
back to provider CLIs when direct upload/deploy implementation would add more
risk than value.

Live provider E2E runs in normal CI as a required check. It may reuse shared
provider projects only when the invocation explicitly allows shared-project E2E
and the alias matches a reserved CI-tools E2E prefix. Provider CI/build systems
are never part of this pipeline; deployable artifacts are built locally. The
lane owns reliable skip semantics for missing credentials so unrelated PRs do
not fail when provider secrets are intentionally unavailable.

## Consequences

- Deploy errors become typed Effect domain errors instead of shell-only stderr.
- Retry policy and observability are derived from error tags.
- Success, skipped, and failure deploy outcomes all emit workflow-report records.
- Nix task modules and generated workflows lose provider behavior and become
  thinner.
- The migration PR has a high merge bar: both Netlify and Vercel must move to
  the new runtime path or the old path must be retained only as an explicit,
  documented rollback gate.

## Rejected Alternatives

- Keep provider behavior in Nix shell and add regex-based diagnostics there.
  This would fix the immediate incident but preserve the wrong source of truth.
- Migrate Netlify first and defer Vercel. This would reduce PR size but leave
  provider deploy semantics split across two control planes.
- Keep live provider E2E non-required. This would reduce merge friction but
  leave provider drift outside the branch-protection contract.
