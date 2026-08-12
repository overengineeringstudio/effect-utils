# 0002 Composed Semantic Model and Generated Package-Local Shards

Status: accepted

## Context

Hand-authored repeated Buck topology creates drift. A universal optional-field
schema erases language semantics, while generator-produced executor discovery
would make tools an undeclared source of graph truth.

## Evidence and Argument

The recorded semantic-model prototype reduced a bespoke megarepo generator
from about 260 lines to about 27 declarative lines and reduced generated BUCK
text by roughly 87 percent. A source-ownership control also showed that a file
addition matching an existing typed file set can change Buck membership without
changing generated BUCK bytes. These were bounded prototype results rather than
production-admission evidence.

The alternative central registry would make unrelated packages share an
authoring and invalidation hotspot. A Buck-only package model would be easier to
introduce but would repeat package, project, test, and artifact facts already
needed by other Genie projections. At the other extreme, per-file targets would
make labels and analysis complexity grow before TypeScript compilers or test
runners demonstrated a matching execution boundary. The evidence therefore
supports one composed semantic model, package-local projection, and semantic
target boundaries that split further only when measurements justify it.

## Options

| Dimension          | Accepted option                                                                                  | Alternatives considered and rejected                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Intent authority   | Shared typed package model consumed by projections                                               | A separate Buck-only model duplicates facts; a central registry creates a repository-wide hotspot |
| Target granularity | Generated semantic project, suite, artifact, crate, library, binary, and build-script boundaries | Per-file targets add speculative graph cost; one coarse package pipeline couples unrelated phases |
| Source ownership   | Typed target-scoped Buck file sets plus an independent census                                    | Generated enumerations churn on topology edits; broad package globs over-invalidate               |

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
