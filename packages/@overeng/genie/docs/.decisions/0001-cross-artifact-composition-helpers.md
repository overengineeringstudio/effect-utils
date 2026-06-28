# 0001: Cross-artifact composition lives in explicit helpers

## Status

Accepted

## Context

Genie generators should provide principled, non-leaky abstractions over the
underlying artifact or system they emit. `packageJson(...)` should model package
manifest authoring, `tsconfigJson(...)` should model TypeScript configuration
authoring, and each generator should remain understandable without knowing the
implementation details of unrelated generators.

At the same time, real repositories need clean composition across generated
artifacts. For example, package manifests expose workspace dependency metadata
that other projections can consume without reverse-engineering rendered
`package.json` files.

## Decision

Genie's default long-term shape is:

- individual generators stay focused on one artifact or domain;
- reusable cross-artifact behavior lives in explicit composition helpers or
  projection helpers that consume structured `GenieOutput.meta`;
- the canonical package export `@overeng/genie` remains the thin,
  unopinionated runtime API;
- more opinionated reusable composition layers are exposed through dedicated
  package subpath exports rather than being mixed into the canonical export;
- the preferred first subpath for reusable cross-artifact helpers is
  `@overeng/genie/composition`;
- `GenieOutput.meta` carries stable semantic facts such as identities,
  relationships, declared capabilities, and normalized authoring intent;
- project-specific policy lives outside Genie core, usually in repository-local
  Genie helper modules such as a `./genie` project directory.

Repository-local policy is a valid escape hatch, not the primary abstraction
boundary for reusable conventions. When a pattern is broadly reusable and can
remain bootstrap-safe, Genie may provide a shared helper for it. When a pattern
encodes project-specific policy, the project should own that layer.

Metadata should not store rendered artifact text or target-location-dependent
relative paths when those values can be computed later by a projection helper
from semantic facts and render context. Project-shape exceptions such as
non-Genie-managed workspace members must stay explicit escape hatches rather
than normal composition inputs.

Admission to `@overeng/genie/composition` requires all of:

- the helper is reusable across repositories;
- the helper consumes explicit semantic inputs or `GenieOutput.meta`;
- the helper remains bootstrap-safe when imported by `.genie.ts` sources;
- the helper does not encode a specific repository's package catalog, patch
  set, private defaults, Nix/FOD closure policy, or comparable local policy.

## Options

| Option                                                                                       | Result                                                                                                                |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Individual generators plus explicit composition helpers                                      | Selected. Preserves generator boundaries while allowing reusable, typed composition.                                  |
| Generators infer from each other automatically                                               | Rejected. It maximizes convenience but creates hidden coupling and makes generator behavior harder to reason about.   |
| Genie core only exposes low-level artifact factories; every repo owns all composition policy | Accepted only as an escape hatch. It is clean locally but causes shared conventions to drift across repositories.     |
| Same package, dedicated subpath exports for opinionated layers                               | Selected. Keeps import paths semantically explicit without prematurely splitting package lifecycle.                   |
| Separate opinionated package such as `@overeng/genie-presets`                                | Deferred. It becomes attractive if policy layers grow large or need independent versioning.                           |
| `@overeng/genie/composition` for reusable cross-artifact helpers                             | Selected. Broad enough for workspace and future projection helpers while still communicating explicit composition.    |
| `@overeng/genie/presets` for the first opinionated subpath                                   | Rejected for this layer. It implies stronger defaults than principled composition helpers should carry.               |
| `@overeng/genie/workspace` for the first opinionated subpath                                 | Rejected for now. It is precise for current package/workspace composition but too narrow for the general abstraction. |
| Strict admission rule for `@overeng/genie/composition`                                       | Selected. Keeps reusable composition separate from project-local policy.                                              |
| Common effect-utils patterns first, generalized later                                        | Rejected. It risks exporting effect-utils assumptions as accidental Genie API.                                        |
| Loose experimental admission                                                                 | Rejected for the canonical subpath. Experiments may remain project-local or behind clearly provisional names.         |
| Stable semantic facts in `meta`; projection data computed later                              | Selected. Keeps metadata portable across target locations and composed repository views.                              |
| Helper-ready rendered or relative-path projection data in `meta`                             | Rejected by default. It simplifies one helper at the cost of leaking output layout into producer generators.          |

## Consequences

- New cross-artifact features should be designed as explicit helpers rather than
  hidden behavior inside existing generators.
- Import paths should communicate abstraction level. Consumers import primitive
  builders from `@overeng/genie`; they import opinionated shared composition
  APIs from named subpaths.
- Helpers that encode effect-utils package defaults, catalog pins, patch sets,
  or Nix/FOD package-closure policy belong in effect-utils-local Genie modules,
  not in `@overeng/genie/composition`.
- Shared helpers must use structured metadata channels, not rendered artifact
  parsing.
- Metadata producers should expose stable facts. Projection helpers should own
  location-specific rendering such as relative paths.
- The runtime/build boundary still applies: helpers imported by `.genie.ts`
  sources must stay bootstrap-safe.
- Project-specific helpers can compose Genie primitives freely, but should not
  be promoted into Genie core until their policy is reusable beyond one project.
