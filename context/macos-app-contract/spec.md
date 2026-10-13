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
  headless from a dedicated signing keychain that holds only that identity;
  the login keychain is never used (0001: login-keychain signing over SSH
  fails with `errSecInternalComponent`).

## Shape

```text
Nix declaration (per product)
  mkMacosApp { name, bundleId, displayName, session, launchd, signer,
               statusAllowedUids, actions, host? }
        |
        +-- hostApp       unsigned .app (host + Info.plist + source-hash marker)
        +-- generation    manifest.json (actions -> payload paths + hashes)
        +-- requirement   expected DR text
        +-- ctl           install/select/converge/verify/rollback/status primitives
                          called by the consumer's activation-bundle steps

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
6. **Signing is headless and fails closed.** The signer unlocks a dedicated
   keychain with a consumer-supplied password and never prompts. If the
   password is unavailable or any signing step fails, activation keeps the
   signed incumbent, applies nothing that needs the new host and reports the
   failure category. It never signs ad hoc, never uses the login keychain and
   never changes key ACLs.
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

`effectUtils.lib.mkMacosApp { pkgs, name, bundleId, displayName, session,
launchd, signer, statusAllowedUids, actions, host ? null, socketMode ? 438 }`
returns `hostApp`, `generation`, `requirement`, `hostSourceHash`, `ctl`,
`ctlConfig` and `primitives`. `hostApp` contains the host executable, a
product-specific Info.plist and `Contents/Resources/host-source-hash`. It has
no Team-ID signature; the Darwin toolchain's execution-required ad-hoc seal is
not a product identity. Action and payload changes replace the generation
without changing host bytes.

| Option    | Values                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session` | `gui-agent`, `background-agent` (default), `system-daemon`. Only `gui-agent` clears `LSBackgroundOnly`.                                                                                                                          |
| `launchd` | `{ label; keepAlive ? true; runAtLoad ? true; extra ? { } }`. `extra` keys are limited to `AssociatedBundleIdentifiers`, `ProcessType`, `ThrottleInterval`, `StandardOutPath`, `StandardErrorPath`, `WorkingDirectory`, `Umask`. |
| `signer`  | `{ teamId; identity; }`. `identity` is a certificate name or SHA-1, never key material and never `-`.                                                                                                                            |
| `host`    | `null` selects the generic host. A product-supplied host is a package with `meta.mainProgram` and a `hostSourceHash` attribute; it must be product-data independent and answer the wire `status` action with that hash.          |

`requirement` is `identifier "<bundleId>" and anchor apple generic and
certificate leaf[subject.OU] = "<teamId>"`. Requirements are compared in the
canonical text form produced by `csreq -t`.

Each action declares `executable` (a Nix store path), fixed `argv`, ordered
`args`, `allowedUids`, `timeoutMs` and `concurrency = 1`. Argument kinds are
`enum` (`values`), `string` (`maxLength`, full-match `pattern`) and `integer`
(`min`, `max`); every argument has a `name` and is required. The builder hashes
payload bytes into the manifest. The host authenticates the socket peer UID,
reads the active pointer for each request, validates arguments and verifies
the payload hash before spawning without responsibility disclaim.

`socketMode` declares filesystem reachability, not authentication. Supported
modes are decimal `384` (0600), `432` (0660) and `438` (0666, the default).
0666 permits a daemon's declared non-owner UIDs to connect; `getpeereid` and
the action/status allow-lists authorize every request regardless of socket mode.
Consumers must own the socket's parent directory, prevent untrusted path
replacement and permit directory traversal for intended callers. Socket mode
is read at startup; changing it requires a host restart.

The host admits at most 32 concurrent connections and gives the entire request
frame an absolute five-second read deadline. Excess connections are closed;
transient accept/resource errors are retried without exiting. A live listener
or a non-socket file at the requested path blocks startup. A stale socket
(`ECONNREFUSED`) is removed before binding, and SIGTERM removes the host's
socket on orderly shutdown without unlinking a replacement path.

The versioned request, result, status and error shapes are defined in
[`wire.schema.json`](../../nix/macos-app/wire.schema.json). Transport is one
newline-delimited JSON request and response per Unix-socket connection.
`serve --socket PATH --generation-pointer PATH` runs the host;
`call --socket PATH ACTION [--arg k=v]` invokes it. Status requires its own
UID allow-list and reports session `unknown` until a supported session API is
integrated. Installation, activation and rollback are provided by the install
primitives below; typed TypeScript clients and panel presentation are not
implemented.

The host uses Rust and the existing pure Darwin SDK capability:
the pinned nixpkgs Swift 5.10.1 compiler cannot import apple-sdk_15.5's
Darwin/Foundation headers. Rust can link AppKit through the same SDK without
constructing an application or showing a window.

## Install primitives

`ctl` (`bin/macos-app-ctl`) is a nonresident Rust executable built beside the
host. It carries the product's `ctlConfig` and is never launchd's Program, so
the TCC subject stays the host. The consumer's activation-bundle framework owns
the per-product state machine (desired state, stamps, holds, pins, GC policy,
serialization) and calls one primitive per step:

| Primitive           | Arguments                                                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-host`      | `--app-dir D --desired APP (--keychain K --keychain-password-fd N \| --signing-auth-pending)` | No-op when the installed marker equals the desired marker, `codesign --verify --strict` passes and the DR equals `requirement`. Otherwise stages a copy beside `D`, signs it, verifies the DR, exchanges it with `D` by `renamex_np(RENAME_SWAP)` and records the incumbent at `D.previous`.                                                                                                                                     |
| `select-generation` | `--state S --generation G`                                                                    | No-op when `S/current` already points to `G`. Otherwise roots `G` with `nix-store --add-root S/roots/<sha256(G)> --indirect`, or records `S/roots/<hash>.path` and reports `consumerRootRequired` when `nix-store` is absent; moves the old pointer to `S/previous`; atomically replaces `S/current`.                                                                                                                            |
| `converge-launchd`  | `--app-dir --state --socket --plist-dir P [--domain auto\|gui\|user\|system]`                 | Renders `P/<label>.plist` with `Program` = the host executable inside `D` and `serve --socket … --generation-pointer S/current` arguments. No-op (read-only `launchctl print` probes only) when the bytes are equal, the job is loaded and the running host reports the installed host hash. Otherwise `bootout` (if loaded) and `bootstrap`. A generation-only change never restarts: the host rereads the pointer per request. |
| `verify`            | `--app-dir --state --socket --desired APP --generation G`                                     | Exact DR, installed marker equals the desired marker, `S/current` equals `G`, and the IPC `status` reports the same host hash, generation and the PID that launchd reports.                                                                                                                                                                                                                                                      |
| `rollback`          | `--app-dir --state --socket --plist-dir [--restore-host]`                                     | Points `S/current` at `S/previous`. With `--restore-host`, which the consumer passes when its own record shows the host was swapped, verifies the archived incumbent's DR and exchanges it back, then restarts the job. Finishes with `verify`.                                                                                                                                                                                  |
| `status`            | `--app-dir --state --socket`                                                                  | Host hash, DR validity, active and previous generation, launchd domain/loaded/PID, session (`gui`, `background-only`, `no-session`), `signingFailure` marker and the running host's IPC status.                                                                                                                                                                                                                                  |

Domain resolution: `system-daemon` uses `system`. Agents use `gui/<uid>` when
`launchctl print gui/<uid>` succeeds; otherwise a `background-agent` uses
`user/<uid>` and a `gui-agent` fails with `gui-absent` without any job
operation. There is no fallback to broader `launchctl` operations.

Each run prints exactly one JSON object on stdout: `{"ok":true,"primitive",
"result"}` or `{"ok":false,"error":{"kind","category","reason"}}`.

| Exit | Kind                       | Meaning                                                                     |
| ---- | -------------------------- | --------------------------------------------------------------------------- |
| 0    | —                          | Converged; `result.changed` tells whether anything was mutated.             |
| 20   | `signing-failed`           | Incumbent untouched; `category` and `D.signing-failed.json` name the cause. |
| 21   | `gui-absent`, `no-session` | Required launchd domain absent; no job operation was attempted.             |
| 22   | `verification-failed`      | DR, marker, pointer, launchd or IPC state differs from desired.             |
| 23   | `operation-failed`         | Filesystem, `launchctl` or `nix-store` operation failed.                    |
| 64   | `invalid-input`            | Bad arguments or config, login keychain, ad-hoc identity.                   |

Signing failure categories: `signing-auth-pending` (consumer could not obtain
the password; the keychain is not touched), `keychain-missing`,
`unlock-failed`, `identity-missing` (identity absent from the dedicated
keychain; the default search list is never consulted), `sign-failed`,
`dr-mismatch`.

### Signer contract

- **Dedicated keychain.** One keychain file holds only the signing identity.
  Its private key is non-extractable. It need not be on the user's search
  list; `codesign --keychain K` selects the identity from it alone.
- **Partition list.** The key's partition list must allow `codesign:`; that
  single entry is the minimum that lets `codesign` use the key without a
  prompt (`security set-key-partition-list -S codesign: -s -k … K`).
- **Password by descriptor.** The consumer owns password retrieval (for
  example an op-proxy grant) and passes it on an inherited descriptor
  (`--keychain-password-fd N`, one optional trailing newline). It is never
  accepted from argv or the environment and never passed to a child process.
  `ctl` reads it into a fixed buffer and zeroes the buffer after unlocking.
  If the consumer cannot obtain the password it passes
  `--signing-auth-pending`.
- **Lock discipline.** Every `install-host` run that names `K` first calls
  `SecKeychainLock(K)`, because a SIGKILLed run skips cleanup. The identity
  lookup and requirement canonicalization happen while `K` is locked.
  `SecKeychainUnlock` then opens a window for exactly one `codesign` of the
  staged bundle and its `codesign` verification; no other child process,
  network or op-proxy call runs inside it. `SecKeychainLock` closes it on
  every path.
- **Never the login keychain.** A path that resolves to the login keychain,
  by name or by `security login-keychain`, is refused before it is opened.
