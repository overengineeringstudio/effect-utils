# Megarepo Open Questions

## Resolved 2026-09-25: which of mr's three layers survive the Buck2 adoption?

The 2026-09-12 investigation split `mr` into a worktree fleet (store,
worktree per ref, GC — consumed by branchy, the agent-policy git wrapper, st2
seats, evergreen, fleet hygiene), pin-and-arrange (`megarepo.kdl` →
`megarepo.lock`, members at `repos/<name>` — consumed by ~30 pnpm
`link:`/`file:` edges, genie `#mr/` imports, Nix `workspaceSources`), and
Buck2 cell composition (decision-0020 shape, cp -a mounts, root generator,
capability projection, dist overlays — consumed by effect-utils' own composed
root only). Buck2 replaces none of the first two; git external cells cannot
replace the third
([buck2 decision 0030](../buck2/.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).

Resolved by
[buck2 decision 0034](../buck2/.decisions/0034-artifact-default-composition-no-registry.md)
and principal q5 (2026-09-25): the first two layers survive; the third is
deleted. MR-R02 to MR-R05, MR-R12, and MR-R13 are retired, and MR-R11 now makes
the standalone worktree the only development context.
