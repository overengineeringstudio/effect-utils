# Downstream Dependency Profile Research

This note preserves the reusable findings from a downstream pnpm/Nix/Buck2
research branch. It is intentionally self-contained: the durable design inputs
are recorded here rather than requiring readers to follow the original branch or
review thread.

## Problem

The pnpm store failure investigation needed a concrete design and proof surface
for a Dependency Materialization Profile boundary. Without a profile boundary,
the pnpm/Nix/Buck2 relationship stayed implicit:

- dependency identity was not tied to a stable set of topology, lockfile,
  toolchain, policy, and store-trait inputs;
- shared pnpm content could be space-efficient but did not have an explicit
  all-roots GC authority;
- Buck2 could observe mutable local dependency output as source-tree churn;
- Nix prepared dependency freshness could drift from the same dependency inputs
  used by live installs.

## Historical Design Decisions Captured

The following list records the imported branch's conclusions, not the current
normative architecture. Decision 0006 and the current subsystem specs supersede
its named live profiles, shared-files registry, and coordinated all-root repair.

- Nix/devenv remains the owner of live mutable pnpm materialization and repair.
- Buck2 consumes declared dependency profile evidence first; it does not run
  opaque ambient `pnpm install` side effects as a cacheable local action.
- Host-wide cache sharing remains a first-class goal. Isolated stores are a
  fallback/debug trait, not the preferred long-term default for local machines.
- Shared content pools require all-root mark/sweep or coordinated rebuild.
  Raw profile-local prune is unsafe for shared package-file pools.
- pnpm build/lifecycle policy is a profile input. If lifecycle behavior is ever
  allowed for a proof class, approvals and native toolchain choices must be
  explicit rather than ambient.
- `nixPreparedDeps` is a Nix-contained TypeScript CLI prepared dependency
  trait, derived from the same profile vocabulary as live pnpm and Buck2
  evidence.

## Durable Evidence Categories

| Category            | Finding                                                                                                               | VRS destination                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Shared-store prune  | Profile-local prune can delete files required by sibling roots sharing `v11/files`.                                   | store authority and verification     |
| Store status limits | `pnpm store status` can report clean after sibling prune even though offline reinstall fails.                         | store authority health checks        |
| Doctor/repair       | Historical split-files repair model used registry-backed all-root repair; current whole-cache repair supersedes it. | store authority and live pnpm repair |
| Store traits        | Shared/split stores preserve large host-wide byte and file-count wins over isolated stores.                           | verification benchmark matrix        |
| CI isolation        | Job-local pnpm stores avoid sibling corruption and stay the CI default.                                               | store trait contract                 |
| Low disk            | Broad proofs must fail before mutation and emit machine-readable skip evidence.                                       | verification skip records            |
| Native/lifecycle    | Native package behavior is profile-policy-sensitive; source-built native compilation needs explicit toolchain policy. | native policy and verification       |
| Profile evidence    | Profile identity is stable across same inputs, changes with lock/policy/store trait, and excludes local output paths. | root profile contract                |
| Nix FOD freshness   | FOD freshness can use profile identity plus FOD input digest instead of parallel stale-hash heuristics.               | Nix prepared deps and FOD evidence   |
| Buck2 evidence      | Buck2 should consume deterministic evidence and keep mutable materialization outside watched source roots.            | Buck2 evidence subsystem             |

## Historical Open Gaps

These gaps describe the imported research snapshot. Current status is owned by
the verification requirements, evidence bundle, and store-authority open
questions rather than this reference note.

- Linux real-workload numbers were still pending; the Linux runner shape was
  proven locally by emitting a deterministic non-Linux skip.
- LiveStore-scale macOS benchmark was stopped by a low-disk guard before the
  full shared-store run completed.
- Buck2 evidence had a working prototype/oracle, but production targets still
  needed evidence from the real Nix/devenv producer.
- Production doctor/repair had model and fixture proof, but still needed
  integration into the canonical live pnpm task surface.
