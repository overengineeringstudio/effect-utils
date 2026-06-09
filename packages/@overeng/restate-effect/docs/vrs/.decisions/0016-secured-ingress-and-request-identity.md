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

`RestateIngress.layer` keeps the literal `{ url }` form as the PRIMITIVE and gains an
optional `apiKey: Redacted<string>` (+ extra `headers`). The key is sent as
`Authorization: Bearer <key>` on every ingress request via `clients.connect({ headers })`.

- **`Redacted`, not `string`.** The key is a `Redacted<string>` so it never prints
  in logs or error messages; it is unwrapped only at the `connect` boundary.
- **`layerConfig` is a thin `Config`-then-literal wrapper.** `RestateIngress.layerConfig()`
  reads the URL from `Config.url('RESTATE_INGRESS_URL')` and the key from
  `Config.option(Config.redacted('RESTATE_INGRESS_KEY'))`, then calls the literal
  `layer`. The key is OPTIONAL (a local dev ingress needs none). The redacted Config
  keeps the secret a `Redacted` end-to-end.

## 2. Request identity (ED25519 signing keys)

`EndpointOptions` gains `identityKeys?: ReadonlyArray<string>` — the SDK's v1
request-identity PUBLIC keys (`publickeyv1_…`). `serve`/`layer` thread them into
`createEndpointHandler({ identityKeys })`, which the SDK forwards to
`endpoint.withIdentityV1(...)`. When set, the SDK REJECTS any inbound request not
carrying `x-restate-signature-scheme: v1` + a valid `x-restate-jwt-v1` JWT signed by
the matching private key — so only the operator's Restate cluster can invoke the
endpoint.

This is a PURE PASSTHROUGH: the binding adds no verification logic; the SDK owns the
handshake. It pairs with the eventual serverless work (a Lambda/edge endpoint must
verify identity), which is deferred — the option is the building block.

## 3. Env-driven config (`Config`)

To make a secured deployment wire-able from the environment without threading values
by hand:

- **Port.** `EndpointOptions.port` accepts `number | Config<number>` (e.g.
  `Config.integer('PORT')`), resolved on layer acquisition. A failing Config fails
  the layer with a `ConfigError`, so `layer`/`serve`'s channel becomes
  `RestateError | ConfigError`. A literal-`number` port never produces a `ConfigError`
  (that arm is structurally unreachable).
- **OTel.** `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME` /
  `OTEL_EXPORTER_OTLP_ENDPOINT` via `Config` and hands the resolved endpoint +
  service name to a caller-supplied `build` that constructs the exporter. The OTLP
  exporter package is the consumer's choice — deliberately NOT pulled into the
  binding's closure (decision 0007's dependency-light rule), so a consumer installs
  only the exporter their collector needs.

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
