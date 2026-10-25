# runtime/

Library code imported by `.genie.ts` files at runtime.

**No npm dependencies allowed** - this code is dynamically imported by the compiled genie binary.

## Output Convention

Genie factories follow this convention:

- first argument: canonical emitted data
- second argument: optional non-emitted metadata

The returned default export is a `GenieOutput<TData, TMeta>` with:

- `data` for emitted output
- optional `meta` for composition by other generators
- `stringify(ctx)` for rendering

Projection helpers should consume `meta` explicitly instead of re-deriving the
same information from generated files.

## Composition Layer

The canonical `@overeng/genie` export is the thin runtime surface for
artifact-focused builders. Reusable cross-artifact helpers live under
dedicated subpath exports so the import path states the abstraction level.

Use `@overeng/genie/composition` for explicit helpers that consume semantic
metadata from generated artifacts. For example,
`tsconfigReferencesFromPackages(...)` projects TypeScript project references
from package workspace dependency metadata without making `tsconfigJson(...)`
know about `packageJson(...)`.

## Filesystem inputs and warm generation caches

With `GENIE_INPUT_MANIFEST` set, a successful full generation or check (all
phases, validation enabled, not a dry run) atomically publishes sorted unique
absolute input paths. Its first line is `genie-inputs-v1` only when the entire
influencing closure is accounted for; otherwise it is
`genie-inputs-incomplete`. Unrestricted generators, transitive helpers, installed
dependencies, and shared engine/validator capabilities currently remain
conservatively incomplete. A completed static import scan is not a completeness
proof.

`genie --check --read-set FILE` additionally records schema-1 observations and
publishes private (`0600`) JSON evidence. `FILE.reasons.json` contains the same
reason occurrences, source modules/packages, and expanded affected-generator
lists, plus `groups` keyed by reason code and exact source location with
`occurrences` counts and unique affected generators. The artifact contains
successful per-target results; it does **not** enable reuse yet. Closure
certification, consumer current-state validation, and per-generator reuse are
not implemented in this recording slice.

Both requested outputs are projections of one invocation's recording.
`GENIE_INPUT_MANIFEST.meta.json` (where the environment variable's value is the
manifest filename) carries the invocation ID, completeness, and whether digest
evidence was requested. The legacy path set equals the file/directory path
union in the read-set, including observed absences. The internal
`validateReadSetPair` helper rejects mismatched invocation IDs, completeness,
or path-only metadata; it validates artifact structure and same-run provenance,
not current filesystem/environment state or reuse eligibility. Failed
checks/publication remove stale evidence rather than leaving a previous
successful result behind.
Partial/dry runs do not request a recording. Without either output, no recording
state, source scan, hashing, or artifact IO is installed. Legacy-only recording
collects paths and reasons, not digest evidence.

For generator filesystem reads use `defineRepoContext().readText/readJson`,
or the Node-only `@overeng/genie/node` exports `inputReadFileSync`,
`inputExistsSync`, `inputStatSync`, `inputReaddirSync`, and
`inputRealpathSync`. These retain Node's overloads and errors and associate
consumed observations with stability checks, including missing optional paths.
Stat recording cross-checks the metadata returned to the caller against exact
bigint evidence; disagreement remains incomplete even if state is restored.
`recordInputEnvironment`
returns the consumed environment value but records only its presence and a
freshly salted digest, never plaintext. `recordInput(path)` declares a dependency
consumed by another API. Recursive directory readers retain nested inventories,
including empty directories. Repeated conflicting observations are incomplete.

This is an explicit input contract, **not** transparent tracing or containment.
Raw filesystem access, environment lookup, native code, subprocesses, computed
imports, and network capabilities remain visible as reasons, rather than being
certified by partial wrappers. The source scan's lexical capability diagnostics
are explicitly unproven; every unaccounted module also receives its own
`unknown-capability` occurrence. Runtime import and validation semantics are
unchanged. Each session starts fresh; evidence is never assembled from a previous
recording or reused module-initialization history.
Within one session, canonical reason/payload keys and decoded prefix, symlink,
and inventory data are cached to avoid repeated serialization and allocation.
Caches do not replace fresh filesystem observations or final stability checks:
directory readers still enumerate raw names and inspect child types, and
traversed prefixes still receive fresh metadata checks.
