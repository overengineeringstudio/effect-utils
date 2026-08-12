# 0007 Sibling Foundations and Explicit Product Integration Joins

Status: accepted

## Context

The VRS subsystem numbers give a useful reading and dependency direction, but a
linear implementation stack would make independently useful foundations appear
to consume one another. Semantic graph contracts, dependency materialization,
execution platforms, and shared product contracts can be developed and reviewed
independently. A real TypeScript or Rust product consumes a selected composition
of those slices.

## Evidence and Argument

The current implementation prototypes exposed the distinction: strict product
contract work, Cargo-workspace authority, execution-platform constraints, and
language dependency materialization each have useful proof without a real
product target. Treating each PR as the base of the next would couple review,
invalidation, and rollback even where no semantic output is consumed.

Completely independent stacks would move the composition risk to the end and
could claim foundation success without proving a product. One monolithic
foundation PR would avoid explicit joins but would enlarge review and cache
boundaries. Sibling foundations plus a product-owned join preserve narrow
boundaries while making the actual composition testable.

## Options

| Option                                       | Tradeoff                                                                  | Outcome  |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| Sibling foundations plus product join        | Narrow review and invalidation; requires explicit composition evidence    | Accepted |
| One linear stack of all foundations          | Simple visual order; invents dependencies and couples unrelated changes   | Rejected |
| Fully independent lanes with no product join | Maximum isolation; defers integration risk and cannot establish admission | Rejected |
| One monolithic foundation                    | One merge event; coarse review, rollback, and invalidation boundary       | Rejected |

## Decision

Keep independently useful foundation slices as sibling changes rooted in the
shared base. A product integration change explicitly composes the exact graph,
dependency, platform, toolchain, artifact, and evidence contracts it consumes.
Only a real semantic consumption edge justifies stacking one foundation on
another. Product admission requires evidence at the integration join; passing
foundation proofs alone is insufficient.

## Consequences

- PR topology reflects semantic dependency instead of rollout convenience.
- A foundation can be reviewed, reverted, and benchmarked independently.
- Product joins are first-class proof subjects and cannot be inferred from a
  sequence of individually green changes.
- Documentation numbering remains stable without implying a total order.
