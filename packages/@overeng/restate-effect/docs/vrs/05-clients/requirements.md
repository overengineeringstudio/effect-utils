# Requirements: 05-clients

**Role.** The typed clients derived from a contract alone — the external ingress
client (with idempotency / attach / output / awakeable resolution) and the
in-handler service-to-service clients. Owns how a typed, validated call crosses
the wire from outside or between handlers.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved.

## Requirements

### Must preserve a typed I/O and client contract

- **R10 Inferred typed clients:** From a contract alone the binding MUST derive
  typed clients — an external ingress client and in-handler service-to-service
  clients — whose arguments are Schema-validated, whose result is the typed
  success, and which require no hand-declared handler shape. The contract MUST
  carry its handler map in a phantom type param; a contract whose handler map
  erases to `Record<string, …>` does NOT satisfy this requirement. (Vision; [../.decisions/0008](../.decisions/0008-typed-client-inference.md).)

### Must expose ingress idempotency, attach, and output

- **R32 Ingress idempotency / attach / output:** The ingress client MUST accept an
  idempotency key on `call` / `send` and MUST expose typed `attach` / `result`
  (get-output by invocation id OR idempotency key) returning the typed success or
  the DECODED terminal error. A Workflow's ingress surface MUST be typed
  `submit` / `attach` / `output` with the `run` handler OMITTED from the direct
  call surface. (Vision; [../.decisions/0008](../.decisions/0008-typed-client-inference.md).)

### Must expose awakeable external completion

- **R33 Awakeable external completion:** `Awakeable.make` MUST return a typed
  `{ id, promise }` (the id branded), serialized via the payload serde. Ingress
  MUST expose typed `resolveAwakeable` / `rejectAwakeable`. Resolution MAY come
  from an in-handler caller OR from ingress. (A03; [../.decisions/0011](../.decisions/0011-restate-schema-annotations.md).)
