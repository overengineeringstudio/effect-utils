# Secured ingress auth + request-identity verification

A secured / Restate Cloud deployment has two trust boundaries the v1 binding left
open:

1. **You → server (ingress).** `RestateIngress.layer({ url })` had NO auth-header
   support, so a secured ingress (which requires a bearer API key) was IMPOSSIBLE to
   reach — a functional gap, not just a hardening one.
2. **Server → handlers (request identity).** The handler-endpoint port was
   UNAUTHENTICATED: anything that could reach it could invoke a handler. The SDK
   supports request-identity verification (ED25519-signed requests), but the binding
   exposed no way to turn it on.

This decision closes both, plus threads the related config from the environment.

## 1. Ingress auth (bearer API key)

`RestateIngress.layer` keeps the literal `{ url }` PRIMITIVE and gains optional
`apiKey: Redacted<string>` (+ `headers`), sent as `Authorization: Bearer <key>`.
`layerConfig` reads URL + optional redacted key from the environment. The key stays
a `Redacted` end-to-end (unwrapped only at the `connect` boundary).

## 2. Request identity (ED25519 signing keys)

`EndpointOptions.identityKeys?` threads the SDK's v1 request-identity PUBLIC keys to
`endpoint.withIdentityV1(...)`, after which the SDK rejects any unsigned inbound
request — so only the operator's cluster can invoke the endpoint. A PURE PASSTHROUGH
(the SDK owns the handshake); it is the building block for the deferred serverless
(Lambda/edge) work, where identity verification is mandatory.

## 3. Env-driven config (`Config`)

`EndpointOptions.port` accepts `number | Config<number>` (so `layer`/`serve` widen to
`RestateError | ConfigError`; a literal port makes that arm unreachable).
`RestateOtel.layerConfig` reads the OTLP env vars and hands the resolved
endpoint/service to a caller-supplied `build` — the exporter package stays the
consumer's choice, NOT in the binding's closure (decision 0007's dependency-light
rule).

## Why this shape

- **`Redacted` for every secret.** Both the ingress API key surface and `Config.redacted`
  keep the credential a `Redacted` end-to-end, so it cannot leak into a log line, an
  error body, or a span — consistent with the redaction discipline
  ([decision 0011](./0011-restate-schema-annotations.md)) and the
  "never a sensitive value on a span" rule (decision 0014).
- **Literal-first, Config-as-wrapper.** Each surface keeps a literal primitive
  (`layer({ url, apiKey })`, `port: number`, `RestateOtel.layer({ resource })`) and
  layers the `Config` form ON TOP as a thin wrapper. The Config path adds no behavior
  beyond reading the environment, so it is trivially correct and the literal form
  stays the testable core.
- **Passthrough for identity.** The SDK already implements the verification; the
  binding's job is only to thread the keys. Re-implementing verification would
  duplicate (and risk diverging from) the SDK.

## Consequences

- `layer`/`serve` channels widen to `RestateError | ConfigError`; the harness
  (`./testing`) converts the structurally-impossible `ConfigError` (it passes a
  literal number port) to a defect so its public channel stays `RestateError`.
- New public surface: `RestateIngress.layerConfig`, `RestateOtel.layerConfig`,
  `EndpointOptions.identityKeys`, and `apiKey`/`headers` on `RestateIngress.layer`.
- Verified server-free: the bearer header + `layerConfig` env reads
  (`src/clients/client-ingress.test.ts`), `identityKeys` reaching the SDK builder
  (`src/endpoint/identity.test.ts`), and the OTel `layerConfig` Config resolution
  (`src/observability/otel.test.ts`). A real signing handshake belongs to the integration lane.

Status: accepted
