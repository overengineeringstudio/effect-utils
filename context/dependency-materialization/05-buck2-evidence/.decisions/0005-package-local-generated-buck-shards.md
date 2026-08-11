# 0005 Package Local Generated Buck Shards

Status: accepted

## Context

The accepted closure model requires generated target roots, exact source and
configuration inputs, context-qualified workspace edges, and target-local
closure manifests. The repository already uses Genie `.genie.ts` sources as
configuration authority and verifies generated-file freshness.

Buck build files define non-overlapping packages. A single generated registry
loaded by every package would make unrelated graph state a shared analysis
input even when resulting action keys remain unchanged.

## Evidence and Argument

- The user selected package-local generated shards in q5.
- The Buck closure prototype proved that a target-local manifest can change
  without executing actions for an unrelated target/package.
- Package-local build files preserve Buck ownership and query boundaries, while
  one central generated registry couples unrelated analysis nodes.
- Existing Genie generation and freshness checks provide a repository-native
  authoring, review, and CI enforcement path.

## Options

| Option                                                        | Tradeoffs                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Checked-in package-local BUCK and manifest shards          | Preserves package ownership and fine-grained analysis inputs; creates more small generated files and requires atomic handling of package moves. |
| B. One generated repository registry with thin package macros | Centralizes the snapshot and reduces file count; makes unrelated package graph changes a shared analysis input.                                 |

## Decision

Choose A.

Generate checked-in `BUCK` files and target/closure descriptor shards at the
smallest stable package ownership boundary. Genie sources, package manifests,
the TypeScript project graph, the lock compiler, and declared target metadata
remain authoring inputs. Shared rule implementations and providers remain
hand-authored `.bzl` modules.

Generation must be deterministic and content-stable: a change to package A may
not rewrite package B's shard when B's configured graph is unchanged. Explicit
source/config lists are preferred so new undeclared files fail freshness rather
than silently entering action inputs.

## Consequences

- Buck can query package-local graph truth without loading one generated global
  registry into every package.
- Generated-file review shows the affected owner and target labels directly.
- Package moves must update old/new ownership, labels or compatibility aliases,
  and closure references atomically.
- The generator may later change physical shard layout while stable labels and
  provider contracts preserve consumers.
- Whole-repository graph exports are derived evidence, not an input loaded by
  every target.
