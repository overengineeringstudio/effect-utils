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

File-set representation remains unresolved as `BUCK.GRAPH-DQ1`; this decision
does not preselect enumeration, owned file sets, or broad globs.

## Consequences

- There is one semantic IR and one projection owner.
- Generated files are reviewable data, not a second authoring surface.
- Generator and helper implementation identities do not enter semantic identity
  unless their observable contract changes.
