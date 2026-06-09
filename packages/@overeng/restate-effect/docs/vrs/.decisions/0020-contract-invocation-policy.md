# Contract-invocation policy as the single annotation-derived transport boundary

The annotation-derived facts that govern HOW a contract handler is invoked —
the input/output **serde** (incl. the `sensitive`-field **redaction** transform),
the `idempotencyKey`-field extraction, the terminal-error decode, and the SDK
opts bag — are derived in ONE place (`clients/InvocationPolicy.ts`), and EVERY
transport adapter consumes it.

## The problem it fixes

Before this, each transport adapter assembled those facts SEPARATELY:

- endpoint materialization (`Endpoint.handlerOpts`),
- the ingress clients (`Client.call` / `objectCall` / `objectSend` /
  `workflowSubmit` / `workflowAttach` / `workflowOutput` / `workflowCall` /
  `result` / `resolveAwakeable`),
- the in-handler service-to-service clients (`callRpc` / `sendRpc` /
  `callDescriptor`),
- the testing harness ingress + `stateOf` (which built its OWN `effectSerde`,
  parallel to production).

So annotation support was **partial by construction**: a fact added to one path
did not reach the others, and adding a new annotation meant editing every
adapter. Two concrete P2 bugs fell straight out of this (both caught by review):

1. **Redaction cipher missing on `Client.call`** — the Service ingress `call`
   built its serdes WITHOUT the `RedactionCipher`, so a contract with a
   `Restate.sensitive` field was un-callable through `RestateIngress` (the encode
   threw `RedactionCipherMissingError`), even though `objectCall` and the served
   handler both encrypted it.
2. **Service idempotency missing on `Client.call`** — the Service ingress `call`
   passed no idempotency key, so a `Restate.idempotencyKey` input field did NOT
   dedupe a retry, even though `objectCall` / `objectSend` extracted it.

And a third structural gap: the **harness drifted** — its ingress connected with
no cipher and its `stateOf` used a parallel `effectSerde` path, so a harness test
could pass while production behaved differently.

## The boundary

`contractSerdeFactory(redaction)` derives — in ONE place, from a contract
handler's schemas + the resolved cipher — the redaction-threaded input/output
serdes; `invocationIdempotencyKey(inputSchema, input)` extracts the key from the
annotated field; `ingressCallOpts` / `ingressSendOpts` fold both into the SDK
`clients.Opts` / `clients.SendOpts` bag. Every adapter takes its serdes + opts
from here:

| Adapter                                               | Consumes                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Endpoint.handlerOpts`                                | `contractSerdeFactory(...).forHandler`                                                 |
| ingress `call`/`objectCall`/…                         | `ingressCallOpts` / `ingressSendOpts`                                                  |
| ingress `attach`/`output`/`result`/`resolveAwakeable` | `...forSchema(schema, 'ingress')`                                                      |
| in-handler `callRpc`/`sendRpc`/`callDescriptor`       | `contractSerdeFactory(...).forSchema(schema, 'internal')` + `invocationIdempotencyKey` |
| harness ingress + `stateOf`                           | the SAME factory (cipher resolved from the served `appLayer`)                          |

The redaction cipher is OPTIONAL and resolved ONCE per boundary: from the
captured runtime at `materialize`, from the surrounding context at
`RestateIngress.layer`/`layerConfig`, and from the served `appLayer` in the
harness. Absent → no cipher (fine unless a served/called contract marks a field
`sensitive`, which then fails loudly at encode/decode — never silent plaintext).

The `RestateIngressService` now carries the cipher (`{ ingress, redaction? }`),
so a `Restate.sensitive` field is encrypted on the wire by EVERY ingress path,
not just the served handler.

## Slot semantics preserved

The slot still decides decode-failure classification (see
[0011](./0011-restate-schema-annotations.md), `02-schema-serde`): the ingress +
served-handler I/O is the `ingress` slot (a malformed payload is a deterministic
`TerminalError(400)`); the in-handler peer-call serde and State stay on the
`internal` slot (a journaled value → a corrupt-journal defect, not a 400 to the
current caller). Threading redaction does not change the slot.

## Placement validation

A field-level annotation applied to the wrong AST node is otherwise a SILENT
no-op (the field-walking readers never see a struct-level annotation; the first
idempotency hit wins). `materialize*` now FAILS LOUDLY via
`validateInputAnnotations` on:

- `Restate.idempotencyKey` / `Restate.sensitive` applied to the input STRUCT
  instead of a FIELD's value schema, and
- MORE THAN ONE field carrying `Restate.idempotencyKey` (an ambiguous key).

## Known limitation

The in-handler `callDescriptor` builder is SYNCHRONOUS (it returns a `Descriptor`
to sit inside a `Restate.all([...])` array), so it cannot resolve the ambient
`RestateRedaction` itself; it threads a cipher only if its caller passes one. The
public `Restate.callDescriptor` / `objectCallDescriptor` do not, so a
`sensitive`-field redaction on a DESCRIPTOR-issued peer call is not yet applied.
Descriptors are outside the call/send/attach/result invariant matrix; the
Effect-based `Restate.call` / `send` paths DO thread it.

## Consequences

- Adding a new annotation-derived transport fact is a ONE-file change in
  `InvocationPolicy.ts`; every adapter inherits it.
- The harness exercises the SAME policy as production (no parallel `effectSerde`).
- An invariant-matrix integration test (Service × Object × Workflow over
  call/send/attach/result) is the regression net: it FAILS on the pre-fix code
  (verified: both P2 findings reproduce) and passes after.

Status: accepted
