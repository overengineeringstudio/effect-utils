# 0004 Role Aware Schema With Measured Refinement

Status: accepted

## Context

Decision 0003 selects shared package payloads, pnpm snapshot contexts, and
target-local closure manifests. The canonical schema needs a task-class
dimension to reach exact steady-state invalidation, but the first authority
proof must also establish resolver parity, strict projection, Buck artifact
identity, observability, and verified Nix import.

Measured repository closures show uneven benefit from immediate role splitting:
`tui-react` has 113 production contexts versus 281 across all dependency
categories, while `megarepo` has 270 versus 275.

## Evidence and Argument

- The user accepted the recommended measured package-first rollout in q4.
- The resolver prototype already models task class and exact target roots, so
  starting conservatively does not constrain the final identity model.
- The Buck prototype proved that changing a target-local manifest reruns the
  exact staging and consumer actions, while unrelated manifest/package changes
  run no actions.
- The measured closure counts show that immediate role splitting has high value
  for some packages and negligible value for others. Benchmark-led refinement
  avoids both premature policy surface and permanently coarse boundaries.

## Options

| Option                                                         | Tradeoffs                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A. Role-aware schema with a conservative first package closure | Preserves the exact end state while limiting the first parity proof; initial targets temporarily include unused dependency categories. |
| B. Exact action-role closures from the first shadow target     | Delivers maximum precision immediately; couples the first cutover to every dependency-category and dynamic-resolution rule.            |

## Decision

Choose A.

Define importer, task class (`runtime`, `check`, `test`, or `tool`), target/exec
platform, and explicit dynamic capabilities in the canonical schema from the
start. The first shadow target may use a clearly named conservative full-importer
closure while the common resolver, projection, evidence, and artifact bridge
are falsified.

After the first parity proof, generate narrower role roots where the benchmark
matrix shows material closure, transfer, projection, or invalidation savings.
The conservative boundary is a compatibility state, not the default steady
state.

## Consequences

- Blob and context identities do not change when a target is refined by role;
  only roots, closure manifests, and exact Buck edges change.
- Every conservative target reports its mode in build evidence and has an
  explicit refinement benchmark or documented no-benefit result.
- A whole-importer closure cannot silently become permanent merely because it
  passed functional parity.
- Dynamic imports, plugins, binaries, configs, ambient types, and conditional
  exports require declared capabilities or must fail under the strict
  projection.
