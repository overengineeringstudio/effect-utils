# 0002 Composed Semantic Model and Generated Package-Local Shards

Status: accepted

## Context

Hand-authored repeated Buck topology creates drift. A universal optional-field
schema erases language semantics, while generator-produced executor discovery
would make tools an undeclared source of graph truth.

## Decision

Author package, project, test, artifact, dependency, and capability intent as a
typed composed model. Genie normalizes it into one language-neutral semantic
graph and emits thin, deterministic, package-local Buck shards. Language
adapters refine closed payloads and lower the same common identities.

Source ownership uses typed, target-scoped Buck file sets plus an independent
mandatory repository census. Genie renders stable file-set expressions but
does not enumerate matching paths into generated BUCK bytes. Broad package
globs are rejected when semantic roles have different consumers; explicit
enumeration is reserved for a distinct invariant that typed patterns cannot
express safely.

## Consequences

- There is one semantic IR and one projection owner.
- Generated files are reviewable data, not a second authoring surface.
- Matching file additions change Buck membership without generated-file churn;
  missing or ambiguous ownership fails the independent census.
- Generator and helper implementation identities do not enter semantic identity
  unless their observable contract changes.
