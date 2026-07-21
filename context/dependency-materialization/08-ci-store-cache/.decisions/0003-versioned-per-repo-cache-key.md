# 0003 Cache Key Is Centralized-Version Plus Per-Repo Prefix

Status: accepted

## Context

The cache key must let one change invalidate every consumer's store (for a
format or policy transition) while keeping repo namespaces isolated and the
store content-correct per platform and lockfile.

## Decision

Compose the key as
`${keyPrefix}-${cacheVersion}-${os}-${arch}-${lockfileHash}`, where
`cacheVersion` is a centralized constant and `keyPrefix` is a per-repo namespace
(atom default, overridable). Restore uses the exact key with no loosening
restore-key fallbacks.

## Rationale

- One authority for invalidation: bumping the centralized `cacheVersion` flips
  every argument-free consumer on repin — the same convergent-version-bump
  discipline used for prepared-artifact transitions (`0004`).
- Namespace isolation without losing that authority: a repo overriding
  `keyPrefix` still inherits the shared `cacheVersion`.
- Content correctness: `os`/`arch`/`lockfileHash` keep the restored store valid
  for the runner and dependency set.
- Exact-key restore avoids serving a mismatched store from a loose restore-key
  fallback (`DMP.CICACHE-R07`).

## Consequences

- A `cacheVersion` bump is a one-time cold rebuild per consumer (`T01`).
- Consumers needing a private namespace pass `keyPrefix`; the default suffices
  for the common case.
- The publisher for a key must run on the flow that warms it and install the
  fullest closure (`DMP.CICACHE-R05`), or the exact key stays cold for
  non-publishing runs.
