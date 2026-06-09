# Shared SSOT helpers in `@overeng/utils` (`freePort`, `formatReasonMessage`)

Cross-cutting helpers that were hand-copied across packages now live ONCE in
`@overeng/utils` and the binding consumes them, so the copies cannot drift:

- `@overeng/utils/node` `freePort()` / `freePorts(count)` / `withFreePort(fn)` —
  the single "ask the OS for a free TCP port" surface. The testing harness and
  the (now-deleted) test helpers no longer carry their own copy.
- `@overeng/utils` (isomorphic) `formatReasonMessage({ reason, label?, method?,
cause? })` — the SSOT for the tagged-error `get message()` body. `RestateError`
  delegates to it; the format is preserved verbatim.
- `Serde.ts` byte encoding goes through `@overeng/utils`'s
  `textEncodeToArrayBuffer` (the existing byte-encoding SSOT), not an inline
  `new TextEncoder()`.

`@overeng/utils` is a PEER + dev workspace dep of the binding (mirroring
`notion-effect-client`), so its peer surface propagates to the consumer rather
than bloating this dependency-light core.

## The `freePort` TOCTOU

The bind-port-0 → read → release → rebind pattern races a co-tenant grabbing the
port in the gap (`Address in use` on parallel server boot). `restate-server` is a
separate child process that binds by NUMBER, so it cannot be handed an
already-listening socket. The fix:

- `freePorts(3)` allocates the server's three listener ports as one batch (all
  `:0` listeners held open until read), so the batch is internally
  collision-free.
- The native-server boot is RETRIED on a port collision — detected via an
  `address in use` / `EADDRINUSE` signature in the child's early-exit logs —
  with a fresh `freePorts(3)` batch, instead of failing the lane.
- `withFreePort(fn)` is the general retry-on-`EADDRINUSE` helper for any
  bind-by-number consumer.

Verified by running the integration lane under 8–12 parallel server boots across
repeated runs with zero collision failures.

## Why

- One source of truth removes the documented latent flake (the TOCTOU lived in
  every copy) and keeps the helpers from diverging in wording/behavior.
- The fix removes the gap rather than papering over it with a sleep/timeout.

## Consequences

- `@overeng/utils` is now in the binding's dependency closure (peer + dev).
- `formatReasonMessage` must preserve the existing message format (no consumer
  pins it, but it is observable in logs/traces).

Status: accepted
