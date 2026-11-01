# Fractal Declaration DSL — Spec

This document specifies reusable TypeScript declaration values, references and lowering. It builds on [requirements.md](./requirements.md). Conformance evidence and capability boundaries are recorded in [COVERAGE.md](../COVERAGE.md).

## Status

Draft.

## Scope

Defines generic authoring values, constructor normalization, scoped assembly and native projection. Does not define domain mission recipes, publication, process execution or authorization enforcement.

## Value pipeline (STDSL-R01–R03)

    constructor input / decoded external input
                   -> canonical schema-derived value
                   -> scoped mission assembly
                   -> validated native projection

Each serializable domain has one exported Effect schema. Public value and encoded types derive from that schema; boundary input codecs derive from its members or normalize into it. Launch, Timing and Review are closed tagged unions. Constructors are thin functions over shared construction/normalization, not alternate implementations. Canonical values contain no native-envelope override fields. Schemas carry hierarchical Fractal.<Module>.<Value> diagnostic identifiers.

Launch distinguishes argv and shell execution. Shared environment, removal and working-directory fields apply consistently to both. Timing distinguishes elapsed recurrence, absolute instant and local-calendar recurrence. Effect Duration and DateTime are normalized once and refined to the selected native grammar's precision/range. Local-calendar time and IANA zone remain explicit; an elapsed day is not a calendar day. Review distinguishes graph subjects and immutable document pins and preserves native-admitted template/file forms through explicit variants or codecs.

## Composition and references (STDSL-R04–R06)

    imported definition -> typed subject reference -> root/revision resolver
    scoped input/product/step handles -------------> mission assembler
    pure domain fragments ------------------------> mission assembler

Reuse existing module-path SubjectRef/SubjectDefinition and scoped StepHandle, input and product APIs. Cross-declaration references carry subject-kind information; the resolver owns path identity and revision serialization. Source identities and scope-bearing capabilities are not interchangeable. Runtime assembly rejects absent targets, incorrect scopes and invalid dependencies even when TypeScript checks are bypassed.

Agent declarations accept an optional `principal: person('person/NAME')`. A principal is a `PersonReference`, never an agent reference. Lowering emits exactly one `principal "person/NAME"` child with no properties or body when set, and no child when omitted. Subject-tree module loading preserves and validates the same field through `AgentSchema`.

Generic values and lowering live in this package. Graph/kit libraries own domain policy and choose values; loaders own discovery/resolution; publishers own publication; native Fractal owns admission and running behavior. Layer-style requirement/output composition is vocabulary for boundaries, not a second runtime scheduler.

Pure values use schema-derived or Effect structural equivalence. Equivalent values hash equally. Scoped handles retain exact provenance; structural equality cannot grant ownership. Effect hashes are not immutable-document cryptographic digests.

Operations are grouped by semantic namespace. Meaningful transformations may have data-first/data-last signatures; constructors do not gain redundant dual forms. Plain immutable values need not implement a builder or Pipeable protocol.

## Policy and exact-plan references (STDSL-R02, STDSL-R07)

Named exec policies are imported typed values with closed schema-validated definitions. The package exposes only semantics admitted by the selected native revision. One immutable plan reference is supplied to document declaration, review and executor input. Until native bounded grants are implemented and admitted, current attributed fresh approvals remain required; library metadata is not reusable consent. Native admission and the executor own enforcement, atomic consumption, revocation, expiry and exact-byte verification.

## Decided input contracts

### DQ1 — Duration inputs

Durations accept Effect Duration values and Effect readable unit strings. Bare numbers are a type error. Both admitted spellings share native refinement and normalization.

```ts
Timing.every({ every: Duration.days(1), anchor })
Timing.every({ every: '1 day', anchor })
// Timing.every({ every: 86_400_000, anchor }) // type error
```

### DQ2 — Absolute-instant inputs

Absolute instants accept Effect DateTime values and strings with an explicit UTC marker or numeric offset. Strings without an offset are rejected. Local-calendar recurrence with an IANA timezone remains a separate constructor; native precision and range checks apply to every admitted instant.

```ts
Timing.at(DateTime.makeUnsafe('2026-10-20T06:00:00Z'))
Timing.at('2026-10-20T08:00:00+02:00')
// Timing.at('2026-10-20T08:00:00') // rejected: no offset
Timing.calendar({ at: '09:00', timezone: 'Europe/Berlin' })
```
