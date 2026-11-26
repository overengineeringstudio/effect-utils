# @overeng/effect-iroh-browser

Effect services for the browser iroh WASM transport. This is separate from
`@overeng/effect-iroh`, the native Node transport; it does not replace that package.

## Transport

The main export provides `IrohNode`, `layerWasm`, `PeerAddress`, the browser-safe
`N0_RELAYS`, framed `Connection` adapters, `Links`, `exclusiveLock`, and typed errors.
`./testing` exports in-memory connection pairs. `./download` exports
`fetchWithProgress`, a streaming downloader whose progress counts decoded bytes rather
than compressed Content-Length; the total grows if the response exceeds the estimate.
It accepts an injected fetch implementation and has no application progress state.

`layerWasm` acquires the optional identity Web Lock, imports and initializes the module
lazily, and owns the endpoint until its layer scope closes. Dialed connections live in
the caller's scope. Supply the identity's 32-byte Ed25519 secret key; the endpoint ID
is its public key. Relay discovery is bounded (25 seconds by default). Relays must
not have trailing-dot hostnames because browser TLS/WebSocket handling rejects them.
No wasm is downloaded simply by importing the main package.

## Browser assets

Explicit exports:

- `@overeng/effect-iroh-browser/wasm`: generated wasm-bindgen web module and types.
- `@overeng/effect-iroh-browser/wasm/iroh.wasm`: generated binary (4,665,524 bytes
  in the extracted artifact).

Bundlers can own the binary URL independently of the binding module. With Vite:

```ts
import wasmUrl from '@overeng/effect-iroh-browser/wasm/iroh.wasm?url'
import { layerWasm } from '@overeng/effect-iroh-browser'

const transport = layerWasm({
  secretKey,
  lockName: 'my-iroh-identity',
  load: async () => {
    const bindings = await import('@overeng/effect-iroh-browser/wasm')
    return {
      ...bindings,
      default: () => bindings.default({ module_or_path: wasmUrl }),
    }
  },
})
```

The application owns URL adaptation, progress presentation, cache/service-worker policy,
and runtime layer composition. To download with progress, initialize the bindings with
`{ module_or_path: await fetchWithProgress({ url: wasmUrl, totalBytes, onProgress }) }`.

## Generated artifact ownership

This package owns `iroh-wasm/` (Cargo source and lockfile) and `wasm/` (the committed
web bindings, declarations, and binary). The committed artifacts allow consumers to
load the transport without installing Rust. Do not hand-edit files under `wasm/`.
Regenerate from the package directory with:

```sh
bash iroh-wasm/build.sh
```

Use Rust with the `wasm32-unknown-unknown` target and wasm-bindgen CLI **0.2.130**,
matching the exact dependency in Cargo.toml. Cargo.lock pins the transitive graph;
the script uses `--locked`. The release profile and web target are retained from the
original producer. Regeneration updates all four companion artifacts together.
The historical crate name `games-iroh-wasm` and generated `games_iroh_wasm*` basenames
are deliberately retained to avoid unnecessary binary regeneration and binding churn.

The historical ALPN `schickling-games/automerge-sync/1` is a wire compatibility
identifier, not a dependency on a game. Its frame limit (8 MiB), accept-handshake
timeout, and connection keepalive/idle settings are preserved. Changing those
identifiers requires a deliberate peer protocol migration. The TypeScript transport
has no application identity, UI, invite, or game-session dependencies.

## Checks

The package's Genie manifest/compiler/Buck definitions own registration and declaration
publication. Vitest covers framing, node scope/relay failures, Web Locks, link ownership,
and decoded-byte download progress. Run the repository's `test:effect-iroh-browser`
task and Buck typecheck after generation and dependency preparation.
