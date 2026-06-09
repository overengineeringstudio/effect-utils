# Requirements: 07-endpoint-deploy

**Role.** The endpoint as a scoped `Layer` (graceful, SIGTERM-driven shutdown),
the trust boundaries a secured / Cloud deployment must close (request-identity
verification + bearer ingress auth + env-driven config), and the
immutable-versioned deployment-evolution contract. Owns how handlers are served
and secured against a running `restate-server`.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
per-invocation boundary the endpoint drives is owned by
[01-authoring](../01-authoring/requirements.md) (R30).

## Requirements

### Must shut down gracefully

- **R29 Endpoint as scoped Layer:** The endpoint MUST be a scoped `Layer` whose
  acquisition starts serving and whose finalizer closes the server, so that
  `serve` under `NodeRuntime.runMain` gives SIGTERM-driven graceful shutdown that
  finalizes the application Layer in the same scope. (A02, A08.)

### Must support secured deployments

- **R38 Secured ingress auth:** The ingress client MUST support a bearer API key so
  a SECURED / Restate Cloud ingress is reachable (it is impossible with the bare
  URL form). The key MUST be carried as a `Redacted<string>` so it never prints,
  sent as `Authorization: Bearer …`. A `Config`-driven form MUST read the URL +
  optional redacted key from the environment (`RESTATE_INGRESS_URL` /
  `RESTATE_INGRESS_KEY`). ([../.decisions/0016](../.decisions/0016-secured-ingress-and-request-identity.md).)
- **R39 Request-identity verification:** The endpoint MUST accept Restate
  request-identity public keys (`identityKeys`, ED25519 v1) threaded into the SDK
  endpoint builder, so the SDK rejects unsigned/unauthorized inbound requests —
  closing the otherwise-unauthenticated handler-endpoint hole. Pure passthrough
  (the SDK owns verification). The endpoint `port` and OTel config MUST also be
  resolvable from `Config` (`port: Config<number>`,
  `OTEL_SERVICE_NAME`/`OTEL_EXPORTER_OTLP_ENDPOINT`).
  ([../.decisions/0016](../.decisions/0016-secured-ingress-and-request-identity.md).)
