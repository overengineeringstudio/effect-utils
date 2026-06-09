# Spec: 07-endpoint-deploy

Specifies the endpoint scoped Layer + `serve`, securing the endpoint + env-driven
config, and deployment evolution. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/](../.decisions/). See [../spec.md](../spec.md) for the index.

Traces: R29, R30, R38, R39, T07, A11.

## 1. Endpoint and serving

Traces: R29, R30. POC reference: `Endpoint.layer` / `Endpoint.serve`. (The
per-invocation boundary it drives is
[01-authoring](../01-authoring/spec.md#per-invocation-runtime-boundary).)

The endpoint is a scoped `Layer`. Acquisition captures the shared runtime,
materializes each implementation, builds the h2c (Node HTTP/2 cleartext) server,
and starts listening; the finalizer closes the server (R29).

Three distinct ports are in play; do not conflate them:

| Port             | Owner                 | Default | Role                                                                                                |
| ---------------- | --------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| ingress          | `restate-server`      | 8080    | external entry point (callers → server)                                                             |
| admin            | `restate-server`      | 9070    | health, deployment registration, State API, management (`./admin`, [10-admin](../10-admin/spec.md)) |
| handler ENDPOINT | this binding's server | 9080    | discovery + invoke (server → handlers)                                                              |

The binding owns ONLY the handler-endpoint port (the SDK server it serves);
8080/9070 belong to `restate-server`. (The testing harness uses OS port-0 for all
of them — see [09-testing](../09-testing/spec.md).)

```ts
serve({ services: [GreeterLive, CartLive], port: 9080 }).pipe(
  Effect.provide(AppLayer), // shared application services, built once
  NodeRuntime.runMain, // SIGTERM → Fiber.interrupt → finalizers
)
```

`serve = Layer.launch(layer(opts))`. Under `NodeRuntime.runMain`, SIGTERM
interrupts the fiber, running the server-close finalizer and every scoped
application finalizer in the same scope — one atomic shutdown path (R29). The SDK
exposes no endpoint-level close; the binding owns the `http2.Http2Server` inside
`Effect.acquireRelease` to provide it.

The endpoint serves h2c (HTTP/2 cleartext, prior-knowledge) via
`http2.createServer(createEndpointHandler({ services }))`. `createEndpointHandler`
takes a `bidirectional?: boolean` (undefined = auto-detect by HTTP version); the
binding leaves it UNSET. VERIFIED (DQ7) end-to-end against native restate-server
1.6.2: with `bidirectional` unset the discovery probe and SDK negotiate full
`BIDI_STREAM`, and a real `ctx.sleep` suspend → persist → resume worked over h2c
prior-knowledge (no TLS/ALPN). `bidirectional: true` is redundant; `false` degrades
to request/response and loses in-stream suspension — so the binding leaves it unset.

## 2. Securing the endpoint + env-driven config (decision 0016)

Two trust boundaries a secured / Restate Cloud deployment must close, plus the
config to wire them from the environment (R38, R39):

- **Request identity (server → handlers, R39).** By default the handler-endpoint
  port is UNAUTHENTICATED. `EndpointOptions.identityKeys?: ReadonlyArray<string>`
  (ED25519 v1 public keys, `publickeyv1_…`) threads into
  `createEndpointHandler({ identityKeys })` → `endpoint.withIdentityV1(...)`. The SDK
  then REJECTS any inbound request lacking `x-restate-signature-scheme: v1` + a valid
  `x-restate-jwt-v1` JWT signed by the matching private key, so only the operator's
  cluster can invoke the endpoint. PURE passthrough (the SDK owns verification);
  pairs with the deferred serverless work. Unset = trusted local network.
- **Ingress auth (you → server, R38).** `RestateIngress.layer({ url, apiKey?, headers? })`
  sends `apiKey` (a `Redacted<string>`, never printed) as `Authorization: Bearer …`
  on every ingress request — reaching a secured ingress that the bare `{ url }` form
  could not (see [05-clients](../05-clients/spec.md#external-ingress-client)).
  `RestateIngress.layerConfig()` is the `Config`-then-literal wrapper: URL from
  `RESTATE_INGRESS_URL`, optional key from `Config.redacted('RESTATE_INGRESS_KEY')`.
- **Config port.** `EndpointOptions.port` accepts `number | Config<number>` (e.g.
  `Config.integer('PORT')`), resolved on layer acquisition; a failing Config fails
  the layer, so `layer`/`serve`'s channel is `RestateError | ConfigError` (the
  `ConfigError` arm is structurally unreachable for a literal-number port).
- **OTel config.** `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME` /
  `OTEL_EXPORTER_OTLP_ENDPOINT` and hands the resolved endpoint to a caller-supplied
  exporter `build` (the OTLP exporter package stays the consumer's choice — not in
  the closure, R03; see [08-observability](../08-observability/spec.md)).

Verified server-free: the bearer header + `layerConfig` env reads
(`src/client-ingress.test.ts`), `identityKeys` reaching the SDK builder
(`src/identity.test.ts`), the OTel `layerConfig` Config resolution (`src/otel.test.ts`).
A real signing handshake belongs to the integration lane.

## 3. Deployment evolution

Traces: T07, A11. See
[../.decisions/0004](../.decisions/0004-determinism-layer.md).

A `Deployment` is immutable and versioned; the `restate-server` owns deployment
versioning and the replay/upgrade contract (A01, A11). The binding registers
deployments and may serve multiple versions; it does NOT route versions itself.

The determinism layer INCREASES the journal's sensitivity to ordinary Effect
refactors (T07): reordering durable ops, adding/removing a `Restate.run`, or
changing combinator order alters the journal shape and is a redeploy/replay
hazard the lint does NOT catch. The mitigation is testing, not a static
guarantee: the harness's multi-deployment registration (see
[09-testing](../09-testing/spec.md#determinism-hunting-modes--lifecycle-contract))
lets a test replay an in-flight journal against a new endpoint version and assert
it still converges.
