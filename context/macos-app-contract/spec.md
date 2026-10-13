# macOS app contract: spec (draft)

Status: draft for direction review. Evidence:
[0001 TCC attribution](./.experiments/0001-tcc-attribution/README.md),
[0002 panel content model](./.experiments/0002-panel-content-model/README.md).

## Purpose

One Nix-level contract for macOS products that need a stable consent
identity: a TCC grant, a GUI session, or both. The contract shares
implementation. It never shares runtime privilege: each product gets its own
bundle ID, designated requirement (DR) and grants.

## Terms

- **Product**: one declared app, for example a backup runner or an approval
  panel. Each product has exactly one bundle ID and one DR.
- **Host**: the product's signed native executable inside
  `<Product>.app`. launchd starts the host directly. The host is the TCC
  subject (0001: T2, T3, T7, T9).
- **Payload**: a Nix store program that the host spawns. Payloads inherit the
  host's grant (0001: T5). For this reason they are declared and pinned.
- **Action**: a closed, named operation that a product exposes over IPC. An
  action maps to exactly one payload invocation with typed arguments. There is
  no generic `exec`.
- **Generation**: an immutable manifest that lists the actions, payload store
  paths, payload hashes and the presentation package. The active generation is
  selected through a pointer that the host reads.
- **Signer**: the code that signs the host with the product identity. It runs
  only in a GUI session with an unlocked login keychain (0001: SSH signing
  fails).

## Shape

```text
Nix declaration (per product)
  mkMacosApp { bundleId, displayName, session, grants, actions,
               presentation?, signer }
        |
        +-- hostApp       unsigned .app (generic host + Info.plist)
        +-- generation    manifest.json (actions -> payload paths + hashes)
        +-- requirement   expected DR text
        +-- steps         activate / verify / rollback / status shell steps
                          for the consumer's activation-bundle framework

Install (consumer activation)
  ~/Applications/<Product>.app      signed host, replaced only when host bytes change
  <state>/<bundleId>/generations/   GC-rooted generation manifests
  <state>/<bundleId>/current        pointer to the active generation
  launchd job                       Program = host executable, never a wrapper
```

## Rules

1. **Host bytes change rarely.** Payload, action-manifest and presentation
   changes only produce a new generation. They never re-sign the host.
2. **Only the host may be launchd's Program.** A resident wrapper becomes the
   TCC subject (0001: T4). Instrumentation that must wrap the job spawns the
   host with responsibility disclaim (0001: T4b).
3. **Payloads are declared and verified.** Before each spawn, the host checks
   that the payload path and hash match the active generation. The host
   spawns without disclaim so the payload uses the product grant.
4. **Actions are closed.** Each action declares its argument schema, timeout,
   concurrency and allowed callers. The IPC schema is generated from one
   source and versioned. A manifest change can add an action only if the host
   version supports the action's argument kinds.
5. **Callers are authenticated.** Socket mode and request-file nonces are not
   authentication. The host checks the peer UID (`getpeereid`). Where a
   product declares a code requirement, the host also checks it against the
   peer audit token. Root system daemons accept non-root callers only for
   actions that declare them.
6. **Signing is deferred, never forced.** If the host bytes changed and no
   signer is available (SSH, no GUI session, locked keychain), activation keeps
   the signed incumbent, applies nothing that needs the new host, and reports
   `pending: signing-needs-gui-session`. It never signs ad hoc and never
   changes key ACLs.
7. **Activation is idempotent.** Activation compares host source hash, DR,
   generation and launchd state. If all match, it does nothing and does not
   restart the job.
8. **Rollback restores a verified incumbent.** Rollback selects the previous
   generation pointer. If the host changed, it restores the archived signed
   host. Rollback then verifies like activation.
9. **Status is exact.** Status reports installed host version and DR, active
   generation, running PID and the generation that the running host loaded,
   and the session state (`gui`, `background-only`, `no-session`).
10. **Presentation is display content.** A product with a panel renders a
    declarative spec (0002) inside a native shell. Decision controls and
    identity come only from validated records, never from the presentation
    package.

## Boundaries

- effect-utils owns the generic host, the Nix builder, the IPC schema and a
  typed TypeScript client.
- Consumers own product declarations, signing identities, activation-bundle
  integration, migrations and grants.
- The contract does not cover CLIs without a consent identity.

## Unsigned builder and host

`effectUtils.lib.mkMacosApp { pkgs, name, bundleId, displayName, teamId,
statusAllowedUids, actions }` returns `hostApp`, `generation`, `requirement`
and `hostSourceHash`. `hostApp` contains the generic executable and a
product-specific background-only Info.plist. It has no Team-ID signature;
the Darwin toolchain's execution-required ad-hoc seal is not a product identity.
`teamId` only parameterizes the expected designated-requirement string.
Action and payload changes replace the generation without changing host bytes.

Each action declares `executable` (a Nix store path), fixed `argv`, ordered
`args`, `allowedUids`, `timeoutMs` and `concurrency = 1`. Argument kinds are
`enum` (`values`), `string` (`maxLength`, full-match `pattern`) and `integer`
(`min`, `max`); every argument has a `name` and is required. The builder hashes
payload bytes into the manifest. The host authenticates the socket peer UID,
reads the active pointer for each request, validates arguments and verifies
the payload hash before spawning without responsibility disclaim.

The versioned request, result, status and error shapes are defined in
[`wire.schema.json`](../../nix/macos-app/wire.schema.json). Transport is one
newline-delimited JSON request and response per Unix-socket connection.
`serve --socket PATH --generation-pointer PATH` runs the host;
`call --socket PATH ACTION [--arg k=v]` invokes it. Status requires its own
UID allow-list and reports session `unknown` until a supported session API is
integrated. Signing, installation, activation, rollback, typed TypeScript
clients and panel presentation are not implemented by the unsigned builder.

The host uses Rust and the existing pure Darwin SDK capability:
the pinned nixpkgs Swift 5.10.1 compiler cannot import apple-sdk_15.5's
Darwin/Foundation headers. Rust can link AppKit through the same SDK without
constructing an application or showing a window.
