# Requirements: 02-schema-serde

**Role.** The single serde seam bridging Effect `Schema` to a Restate `Serde`,
the JSON wire + discovery payload, and the Symbol-keyed Schema annotation
namespace (terminal/retryable, custom serde, retention, idempotency key, field
redaction) read at one site each. Owns how a typed value crosses every
Restate-managed slot.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
slot-aware FAILURE classification (R16) is stated under
[04-error-boundary](../04-error-boundary/requirements.md) since it is part of the
error model, but is implemented in the serde (see this subsystem's spec).

## Requirements

### Must preserve a typed I/O and client contract

- **R07 Schema-typed I/O:** A handler's input, success, and business-error types
  MUST be declared as Effect `Schema`s and enforced at the boundary: input is
  decoded before the handler runs and success is encoded after. (A03, A06; [../.decisions/0010](../.decisions/0010-separated-contract-impl.md).)
- **R08 JSON wire + discovery:** The serde MUST emit `application/json` for the
  encoded wire shape and MUST surface the schema's JSON Schema for Restate
  discovery. (A03, A06.)
