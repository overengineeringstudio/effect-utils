# 0004 Stateless Owned-File Assertion

Status: accepted

## Context

Typed Buck-owned file sets cannot by themselves detect a supported file absent
from the declared graph. Giving a Buck action the whole repository would create
a coarse invalidation boundary, while evaluating patterns in Genie would
duplicate Buck's package and glob semantics.

## Decision

Use one stateless command that enumerates Git tracked and nonignored untracked
candidate paths, submits them to one batched Buck ownership query, and performs
only a deterministic zero/one/many join. Buck is the sole file-set matcher.

The command emits sorted `buck-owned-files/v1` JSON and exits pass or fail. It
has no daemon, database, cache, committed report, custom matcher, graph
compiler, BXL framework, or repository-wide Buck action. The supported-file
policy is projected from the semantic package model rather than duplicated in
the checker.

## Consequences

- Undeclared and multiply owned supported files fail closed.
- Ordinary Buck actions retain fine-grained inputs and cache identities.
- Genie freshness, semantic completeness, and Buck execution remain distinct
  checks with distinct authorities.
- The command can be replaced by a future native Buck equivalent without
  changing the semantic model or report contract.
