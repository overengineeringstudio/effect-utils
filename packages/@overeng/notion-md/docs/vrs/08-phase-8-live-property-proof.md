# Phase 8: Live Property-Proof Completeness

## Scope and current boundary

Phase 8 closes two gaps in the standalone live proof for data-source-scoped
property writes: (1) complete per-property schema evidence and a truthful
schema-shape failure, and (2) relation-target availability verified against
live pages and sharing state. It consolidates the `retrieveDataSource` TODO in
`src/live.ts:347-369` with the relation TODO in `src/property-proof.ts:246-267`
and the live-coverage TODO in `src/property-proof.unit.test.ts:339-348`.

The current client exposes `dataSource.properties` as `Record<string, unknown>`
and does not validate entries at the client boundary (`src/live.ts:350-356`).
The provider currently extracts only `id`, `name`, and `type`, silently omits
malformed entries, and can therefore turn malformed schema into an apparent
identity ambiguity (`src/property-proof.ts:72-87,200-215`). It already compares
the writable whole-schema hash when an expected hash is present, but only
threads the descriptor's expected `config_hash`; it does not compute an
observed per-property config hash (`src/property-proof.ts:217-231`). Relation
availability is currently set to `all-available` for relation properties
without inspecting target pages (`src/property-proof.ts:255-267`). The pure
property-write core already exercises the blocking guards for stale schemas and
unavailable/unshared relation targets (`src/property-proof.unit.test.ts:339-348`).

**Current limitation and required interim posture:** the live provider currently
reports `all-available` for every relation property without checking any target
pages (`src/property-proof.ts:255-267`). That verdict is optimistic and does NOT
prove target existence, data-source membership, or sharing; it must not be
described as conservative. Until Phase 8.2's live check is implemented, callers
must treat relation writes as unverified. Phase 8.0's first safety change is to
make the standalone provider fail closed for relation writes. A proof must use
observations from the same fresh live read as its property identity and desired
write. Missing, inaccessible, malformed, or ambiguous remote evidence MUST
block; never turn an incomplete observation into an allow verdict.

## Phased plan and entry criteria

### Phase 8.0 — Establish schema-evidence contract

**Entry criteria:** the pinned Notion API schema/client version is identified,
and the team agrees which property configuration fields affect write safety.
The contract must distinguish writable configuration (e.g. select/status
options and relation configuration) from display-only fields, and define how
unrecognized provider fields are handled. Do not infer completeness from the
property map's display-name keys alone.

**Work:** document the validated per-property schema shape at the
`notion-effect-client` boundary; agree whether validation belongs in that client
or a shared schema decoder consumed by it. Specify typed failure distinctions
for invalid schema payload vs a valid schema with zero/multiple matches. Define
the canonical writable config projection and hash, compatible with the
`ConfigHash` carried by the `.nmd` property descriptor.

**Exit criteria:** fixtures cover each supported property type/config plus
missing required keys, wrong value types, and unknown type tags. The decoder
rejects malformed shape with a schema-specific error rather than silently
filtering entries into `PropertyIdentityAmbiguous`. The same projection has
unit vectors proving equality for semantically equal config and inequality for
write-affecting changes; display-only changes have an explicit expected result.
No provider code relies on undocumented Notion response shape.

### Phase 8.1 — Make live per-property schema proof complete

**Entry criteria:** Phase 8.0 schema shape and writable-config projection are
reviewed and available through a typed/validated client result.

**Work:** use the validated schema to resolve property identity, type, and
write class; compute both observed schema hash and observed config hash from the
fresh schema snapshot; compare against authored expected hashes when present.
Preserve the current whole-schema writable projection semantics. Surface
malformed response separately from a legitimate missing/ambiguous display name.
Keep reads and proof construction bound to the same `(dataSourceId, propertyId)`
identity used by `DesiredPropertyWrite` (`src/property-proof.ts:183-215`).

**Exit criteria:** unit tests exercise present/absent expected schema and config
hashes, drift in writable vs display-only configuration, malformed/unknown
schema data, renamed and duplicate display names, type/tag mismatch, and the
resulting exact guard decision. Existing guard blocks (`StaleRemoteSchema`,
`SchemaDriftAffectsIntent`, `PropertyIdentityAmbiguous`) remain delegated to the
pure core rather than duplicated in the provider. Live coverage uses
independently authored expected hashes, not hashes derived from the same
observation under test.

### Phase 8.2 — Prove relation-target completeness

**Entry criteria:** Phase 8.0 defines the relation schema semantics and Phase
8.1 provides a validated relation property plus its config (including whether a
single or dual relation is configured). The gateway contract can retrieve every
related page's identity and parent data-source identity and can determine
whether that data source is shared with the caller's integration.

**Work:** for every desired related page id, perform a fresh live existence
check and establish that it belongs to the expected relation target
data source and that this data source is shared with the integration. Map
results into the proof's relation-availability status using the established
shared core contract. Empty desired relations are vacuously available only if
the core contract explicitly says so. Any missing page, mismatched parent,
unknown parent, unavailable permission/share evidence, or partial page of
results must not be reported as `all-available`. Avoid overfetching relation
content: identity/parent/share evidence is sufficient. Bound requests according
to Notion API limits without weakening completeness.

**Exit criteria:** deterministic gateway-fake tests cover empty list, one and
multiple valid targets, missing target, target in wrong data source, unshared
data source, API permission failure, malformed target response, and a partial
multi-target read. Each case asserts the exact proof status and shared-core
allow/block guard. Tests prove all requested ids are checked once and that no
partial result reaches an allow decision.

### Phase 8.3 — Verify through live Notion and close the TODOs

**Entry criteria:** Phases 8.1 and 8.2 pass their unit-level exit criteria; a
safe, isolated Notion test workspace and non-production integration are
available. Live test fixtures can be created and cleaned up without mutating
user pages.

**Work:** create an independently authored relation data source, target pages,
and a relation property; exercise shared and unshared access, removal/missing
page, and stale schema/config expectations. Record only non-sensitive evidence
(ids/hashes/verdicts); do not log tokens or page content. Ensure cleanup is
reliable and limited to objects created by the test. If live credentials or an
isolated workspace are unavailable, keep this phase explicitly unverified and
retain fail-closed production behavior.

**Exit criteria:** integration tests demonstrate stale-schema/config and
relation-target verdicts against real API responses; a deliberate missing or
unshared target blocks, while complete shared targets allow only when every
other proof guard passes. Remove the `TODO(phase-8-live-l6)` comments only after
this evidence exists; replace them with the lasting contract and links to the
completed tests.

## Non-goals

- Do not change the property-write core's policy or duplicate its guard logic in
  the standalone provider.
- Do not add retries, caching, broad gateway redesign, telemetry, or unrelated
  property value support as part of this phase.
- Do not treat successful schema retrieval as proof that relation targets are
  complete or shared.
- Do not claim live Phase 8 coverage based only on pure-core unit tests; those
  prove guard behavior, not the live provider's observations.
