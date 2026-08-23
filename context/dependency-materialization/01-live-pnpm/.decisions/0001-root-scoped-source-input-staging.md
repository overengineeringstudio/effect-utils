# 0001 Root-Scoped Source Input Staging

Status: accepted

## Context

A composed workspace consumes canonical package source owned by standalone
repository roots. Direct `link:` and `file:` realization can expose those
canonical files to consumer tooling, while copying every installed occurrence
creates a second dependency materializer and multiplies state within one root.

## Evidence and Argument

- Materialization-Root isolation is the existing authority boundary; package
  consumers inside one root are not independent mutation owners.
- pnpm must remain the only mechanism that selects and realizes Package
  Instances and Dependency Edges.
- A root override targeting one published source generation supersedes
  consumer-local links, and a subsequent managed install refreshes realized
  bytes after source changes.
- One generation per declared source set retains root isolation with less
  copied state than one detached copy per installed occurrence.

## Options

| Option                                 | Tradeoffs                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Root-local Source Input generation     | Keeps canonical source read-only and pnpm authoritative; consumers in one root share published bytes. |
| Post-install per-occurrence detachment | Provides stronger inode separation than required but adds a second materializer and repeated copies.  |
| Preserve canonical live links          | Has the least staging machinery but does not prevent consumer tooling from mutating canonical source. |

## Decision

effect-utils owns one reusable primitive that stages, identifies, validates,
and safely publishes each aggregate root's declared Source Inputs. A downstream
root declares the source set and generates topology overrides; it does not add
a second hook or materializer.

The primitive constructs a complete versioned generation, verifies canonical
source remained stable, makes the generation read-only, and publishes it with
an atomic pointer switch in the managed pnpm mutation transaction. Readiness is
read-only and reports a miss when the published generation is stale or drifted.
pnpm then exclusively realizes the graph from that published generation.

Isolation is defined between Materialization Roots. Package Instances inside
one root may share read-only published bytes; per-consumer inode isolation is
not part of the contract.

## Consequences

- Canonical sibling-repo source remains read-only during aggregate installs.
- Install, update, and deduplicate operations use the same staging policy.
- The declared source set and canonical content own freshness; no separate
  staged-output state machine is introduced.
- Post-install edge rewriting and parallel composed-source manifests are not
  needed.
