# @overeng/effect-iroh-automerge

An automerge-repo network adapter and Effect network lifecycle over
`@overeng/effect-iroh-browser`. It does not depend on the native `@overeng/effect-iroh`
package, application identity, game rules, or UI state. TypeScript is retained at
the JavaScript automerge-repo and Effect service boundary.

## Public API

- `IrohNetworkAdapter`: automerge-repo NetworkAdapter over framed iroh connections.
- `remotePeers` and `deviceIdOfPeer`: connected remote repo peers and endpoint identity
  extraction. Repo PeerIds follow `<endpointId>-<tab>`.
- `Net`, `makeNet`, `RepoNetwork`, and `Wakeups`: scoped startup, transport acquisition,
  incoming connections, shared dial loops, and network-wakeup integration.
- `Session`, `NetStatus`, `PeerState`, `dialBackoff`, and `UNREACHABLE_AFTER`: lifecycle
  state and the existing bounded dial policy.
- `mesh`: maintain connections to the latest peer set. An undefined set does not
  start networking; the first concrete set brings the endpoint online, even if empty.
  Removed peers release their shared connection claims. The internal keyed-fiber
  helper keeps one fiber per key and interrupts removed fibers and the whole set
  when its owner ends.

Run adapter connections and network operations in a caller-owned Effect scope. Closing
that scope closes connections and cancels retries. Competing outgoing/incoming links
agree on the lower endpoint ID's dial, so only one connection survives. A repo peer
is bound to the authenticated transport endpoint; received sender identities cannot
impersonate another endpoint. Replacing a link emits disconnection first to reset
automerge-repo sync state.

The application supplies repo/identity policy, persistence, invitations, wakeup streams,
and concrete layer composition. This package preserves startup status, retry/backoff,
relay-failure recovery, and reference-counted connection ownership independently of
those policies.

## Wire compatibility

The handshake discriminator `games-hello` and version **1** are retained historical
wire identifiers, not game-specific runtime dependencies. The browser transport also
retains its deployed ALPN. Do not rename either as cosmetic package cleanup: doing so
would disconnect existing peers and needs an explicit protocol migration.

## Checks

The Genie manifest/compiler/Buck definitions own package registration and declarations.
The package Vitest configuration includes adapter, network lifecycle, keyed mesh, and
real automerge-repo ephemeral-message integration tests. Run the repository's
`test:effect-iroh-automerge` task and Buck typecheck after dependency preparation.
