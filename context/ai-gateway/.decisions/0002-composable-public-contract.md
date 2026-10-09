# Decision 0002: One public contract with language realizations

Status: accepted

## Context

Gateway behavior and language-specific client behavior overlap. Separate flat
contracts can disagree about authentication, schema validation, streaming usage,
and native decision semantics. Public wire behavior must not depend on private
deployment documentation.

## Evidence and Argument

The 2026-10-09 composition decisions q3 and q4 select one public root owning all
consumer-observable behavior, with Effect and Rust refinements below it. The
server's consumer requirements and the existing Effect requirements share model,
chat, authentication, structured-output, decision, and boundary constraints.
The q28 capability decision includes tools and client GenAI telemetry; an
async-only surface satisfies that decision.

## Options

| Option | Tradeoff |
| --- | --- |
| Public root with language realizations (selected) | States the consumer contract once; scoped descendant IDs make refinements traceable. |
| Separate client/server roots | Repeats shared guarantees and leaves the wire dependent on private documentation. |
| One language-specific root | Makes other clients inherit accidental language mechanisms. |

## Decision

The root owns the vision, language-neutral requirements, public wire, and shared
ontology. `01-effect` and `02-rust` refine root IDs and own their mechanisms.
Gateway realizations refine the public contract elsewhere and retain deployment,
credential custody, server accounting, and topology facts outside this tree.
The root owns the Chat Completions choice; language-specific foundation choices
belong to their realization's decision records.

### Requirement provenance

These source IDs identify the pre-composition requirements, not parallel active
requirements in this tree. `AIGW` identifies server consumer requirements; `TS`
identifies the prior Effect-client requirements.

| Public ID | Source | Preserved obligation |
| --- | --- | --- |
| AIG-R01 | AIGW-R01; TS R01 | Shared chat and unchanged discoverable model IDs. |
| AIG-R02 | AIGW-R05; TS R02 | Explicit/environment auth, redaction, independent revocation. |
| AIG-R03 | AIGW-R01; TS R03, R06 | SSE and supplied generation/decision usage. |
| AIG-R04 | AIGW-R03; TS R04 | Wire/backend neutrality and stable endpoint/auth/model/payload. |
| AIG-R05 | AIGW-R02; TS R05 | Structured formatting or refusal. |
| AIG-R06 | AIGW-R02; TS R05; explicit original-schema obligation | Local validation despite strict relaxation/provider projection. |
| AIG-R07 | AIGW-R04; TS R06 | Native typed decisions with default/selected model and checked answers. |
| AIG-R08 | AIGW-R04; TS R07 | Native probability integrity, no calibrated-chat substitute. |
| AIG-R09 | TS R08 | Client/gateway/runtime responsibility boundary. |
| AIG-R10 | AIGW-R10; TS R05, R06 | Distinguishable HTTP, stream, provider, and invalid-output failures. |
| AIG-R11 | q28; Effect provider tool surface | Tool-call exchange without implicit execution. |
| AIG-R12 | q28; inherited Effect GenAI annotations | Client-side semantic spans and honest usage/outcomes. |

## Consequences

The [public requirements](../requirements.md) are the active ID authority.
Realizations reference them with `refines:` rather than repeating them.
Private deployment IDs remain owned by gateway realizations; they are not public
configuration names. One shared public fixture set is reserved by
[the specification](../spec.md#conformance-fixtures), with no assigned path.
