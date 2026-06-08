# First-class Effect-native, Docker-free testing harness (./testing)

The binding exports a testing harness (subpath `./testing`) as a scoped `Layer`
that boots a real native `restate-server` (no Docker) on ephemeral ports + an
isolated base dir, registers the deployment, and exposes the typed ingress client
+ state inspection. Consumers use it to integration-test their own Restate
services. This is the Docker-free, Effect-native counterpart to Restate's
`@restatedev/restate-sdk-testcontainers`.

CI runs the integration tests as a dedicated job (nixpkgs `allowUnfreePredicate`
scoped to `restate`, `restate-server` from `nix/restate.nix` on `$PATH`,
serialized, generous timeout). Ephemeral ports + isolated base dir make tests
parallel-safe and fix the POC harness's fixed-port flakiness.

## Why

- The consuming ecosystem is Effect; a scoped-Layer, Docker-free, ephemeral-port
  harness is both a differentiator from the testcontainers path and ~80% already
  built in the POC.
- A dedicated CI job contains server-spawn cost and the unfree binary.

## Consequences

- `restate-server` must be available to CI (nix derivation + scoped allowUnfree).
- The harness is public API and must stay stable.

Status: accepted
