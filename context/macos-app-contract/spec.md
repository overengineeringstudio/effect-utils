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
UID allow-list and reports the host's own audit session (`SessionGetInfo` for
the calling session): `no-session` for the root session or when the call
fails, `gui` when the session has graphic access, otherwise `background-only`.
Installation, activation and rollback are provided by the install primitives
below; typed TypeScript clients and panel presentation are not implemented.

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

| Primitive           | Arguments                                                                                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-host`      | `--app-dir D --state S --desired APP (--keychain K --keychain-password-fd N \| --signing-auth-pending)` | First reconciles an interrupted install exchange, then the install-host side of an interrupted host rollback (below). No-op when the installed marker and bundle-metadata digest (sha256 of `Contents/Info.plist`) equal the desired ones, `codesign --verify --strict` passes and the DR equals `requirement`. Otherwise stages a copy beside `D`, signs it, verifies the DR, writes `D.txn.json`, exchanges the stage with `D` by `renamex_np(RENAME_SWAP)` and publishes the archive: `S/host-previous-generation` records the generation the incumbent ran with and `D.previous` points to the incumbent. Reports `reconciled` and `leftovers`.                                                                                           |
| `select-generation` | `--state S --generation G`                                                                              | No-op when `S/current` already points to `G`. Otherwise roots `G` with `nix-store --add-root S/roots/<sha256(G)> --indirect`, or records `S/roots/<hash>.path` and reports `consumerRootRequired` when `nix-store` is absent; moves the old pointer to `S/previous`; atomically replaces `S/current`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `converge-launchd`  | `--app-dir --state --socket --plist-dir P [--domain auto\|gui\|user\|system]`                           | Renders `P/<label>.plist` with `Program` = the host executable inside `D` and `serve --socket … --generation-pointer S/current` arguments. No-op (read-only `launchctl print` probes only) when the bytes are equal, the job is loaded, the running host reports the installed host hash, `S/launched-app-inode` equals the inode at `D` and the socket mode equals the active generation's `socketMode`. A plist, host or bundle exchange (including metadata-only) causes `bootout` (if loaded), `bootstrap` and a new `S/launched-app-inode`. A `socketMode` change alone causes `launchctl kickstart -k` and reports `restart: "socket-mode"`. Any other generation-only change never restarts: the host rereads the pointer per request. |
| `verify`            | `--app-dir --state --socket --desired APP --generation G`                                               | Exact DR, installed marker and bundle-metadata digest equal the desired ones, `S/current` equals `G`, the socket mode equals `G`'s `socketMode`, and the IPC `status` reports the same host hash, generation and the PID that launchd reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rollback`          | `--app-dir --state --socket --plist-dir [--restore-host]`                                               | Resumes a pending `D.rollback.json` first, whatever the flag. Without `--restore-host`, a generation rollback: points `S/current` at `S/previous` and converges (no restart unless `socketMode` differs). With `--restore-host`, a host-only rollback that the consumer passes when its own record shows the host was swapped (below). Both finish with `verify`.                                                                                                                                                                                                                                                                                                                                                                             |
| `status`            | `--app-dir --state --socket`                                                                            | Host hash, bundle-metadata digest, DR validity, active and previous generation, `hostArchive`, `hostArchiveGeneration`, `interruptedTransaction`, `interruptedRollback`, socket mode, launchd domain/loaded/PID, session (`gui`, `background-only`, `no-session`), `signingFailure` marker and the running host's IPC status.                                                                                                                                                                                                                                                                                                                                                                                                                 |

The consumer calls `install-host` before `select-generation` in one
activation, so `S/host-previous-generation` records the generation the
incumbent host actually ran with.

**Install transaction.** `D.txn.json` (`stage`, `stageInode`, `generation`,
`superseded`) is durable before the exchange. The exchange is the commit
point: before it, a failure discards the stage and leaves `D` untouched; after
it, the install only rolls forward and never exchanges back. Publication sets
`S/host-previous-generation`, then `D.previous`, clears the signing-failure
marker and removes `D.txn.json` last; each step is idempotent. A failure or
crash before the record is removed leaves it for `install-host` or `rollback`
to reconcile before anything else: if the inode at `D` equals `stageInode`, the
publication is completed; otherwise the stage is discarded. Removing the
`superseded` archive comes after the record is gone and is best-effort: a
failure is reported in `leftovers` and never undoes the install. Results report
`reconciled: "archive-published" | "stage-discarded" | "rollback-discarded" |
"rollback-host-restored" | null`.

**Host rollback transaction.** `rollback --restore-host` verifies the archive's
DR, then writes `D.rollback.json` (`archive`, `targetGeneration` =
`S/host-previous-generation` or else `S/current`, `restoredInode`,
`rejectedInode`) before the exchange. The steps are idempotent: exchange only
while the inode at `D` is `rejectedInode`, select the target, converge (the new
inode at `D` restarts the job once), verify. `D.previous`,
`S/host-previous-generation` and the record are removed only after verify
succeeds, so a failed `select`, `launchctl` or verify step, or a crash, is
retried to completion by the next `rollback`. The rolled-away bundle is then
deleted best-effort (`leftovers`). A repeated `--restore-host` after success
fails with `No archived host` and never flips back. A pending record seen by
`install-host` is discarded if the exchange did not happen; otherwise
`install-host` selects the target generation and retires the rollback state,
leaving restart and verify to the consumer's following steps.

Domain resolution, for `auto` and for explicit `--domain` alike:

| Session            | Allowed `--domain`    | Resolves to                                                              |
| ------------------ | --------------------- | ------------------------------------------------------------------------ |
| `gui-agent`        | `auto`, `gui`         | `gui/<uid>` when `launchctl print gui/<uid>` succeeds, else `gui-absent` |
| `background-agent` | `auto`, `gui`, `user` | `auto`: `gui/<uid>` when present, else `user/<uid>`; `gui` requires it   |
| `system-daemon`    | `auto`, `system`      | `system`                                                                 |

Any other combination is `invalid-input` before any `launchctl` call. There is
no fallback to broader `launchctl` operations.

`converge-launchd` derives `LimitLoadToSessionType` from the kind and resolved
domain, never from consumer extras: `gui-agent` in `gui/<uid>` gets `Aqua`;
`background-agent` in `user/<uid>` gets `Background`, and in `gui/<uid>` gets
`Aqua`; `system-daemon` has no session-type key. Any consumer-provided value
is replaced (or removed for a system daemon), so it cannot override this
contract. Without this key, launchd defaults an agent to the Aqua session and
cannot bootstrap it into a Background user domain.

A restart (`bootout` then `bootstrap`) waits up to 10 seconds until
`launchctl print` stops reporting the label after `bootout`. launchd can still
be tearing the job down when `bootout` returns, and an immediate `bootstrap` of
the same label then fails with `5: Input/output error`. If the label is still
loaded at the deadline, the step fails with exit 23 (`operation-failed`).

Each run prints exactly one JSON object on stdout: `{"ok":true,"primitive",
"result"}` or `{"ok":false,"error":{"kind","category","reason"}}`.

| Exit | Kind                       | Meaning                                                                                                                                                                                      |
| ---- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —                          | Converged; `result.changed` tells whether anything was mutated.                                                                                                                              |
| 20   | `signing-failed`           | Incumbent untouched; `category` and `D.signing-failed.json` name the cause.                                                                                                                  |
| 21   | `gui-absent`, `no-session` | Required launchd domain absent; no job operation was attempted.                                                                                                                              |
| 22   | `verification-failed`      | DR, marker, metadata, pointer, socket mode, launchd or IPC state differs; codesign guard refused; certificate does not pair; signing-key proof failed.                                       |
| 23   | `operation-failed`         | Filesystem, `launchctl` or `nix-store` operation failed.                                                                                                                                     |
| 64   | `invalid-input`            | Bad arguments or config, login keychain, keychain outside a per-user `Library/Keychains`, missing or invalid ACL record, ad-hoc identity, existing key without `--replace`, domain override. |

Signing failure categories: `signing-auth-pending` (consumer could not obtain
the password; the keychain is not touched), `password-invalid` (descriptor
content rejected before unlock), `keychain-missing`, `unlock-failed`,
`identity-missing` (identity absent from the dedicated keychain; the default
search list is never consulted for identity lookup), `chain-incomplete` (the
code-signing chain does not reach a trusted anchor; no codesign runs),
`sign-failed`, `sign-timeout` (a signing, verify or detail `codesign` did not finish within
30 seconds and was killed), `dr-mismatch`,
`relock-failed` (the keychain could not be locked again; the signed stage is
discarded). A codesign-guard refusal (below) is `verification-failed` and
runs no `codesign`.

`MACOS_APP_CTL_TEST_FAILPOINT` (`relock`, `after-exchange`,
`after-archive-pointer`, `cleanup`, `rollback-after-exchange`) is test-only. It
can only force a failure or a crash, never make a check pass.

### Signer contract

- **Dedicated keychain.** One keychain file holds only the signing identity.
  Its private key is non-extractable. It need not be on the user's search
  list; `codesign --keychain K` selects the identity from it alone.
- **Partition-capable location.** `K` lives in a per-user `…/Library/Keychains/`
  directory (production: `~/Library/Keychains/<name>.keychain-db`). securityd
  creates partition-version keychains only there; anywhere else the key has no
  partition list or integrity entry, partition settings are silently void and
  codesign's exclusive access cannot be established. `install-host` and the
  provisioning primitives refuse any other location (`invalid-input`).
- **Partition list exactly `[apple:]`.** securityd gives every client a
  partition ID derived from its code signature: Apple-signed binaries get
  `apple:` (so `/usr/bin/codesign` is `apple:`), `security` alone gets
  `apple-tool:`, Mac App Store and Developer ID code gets `teamid:<id>`, other
  signed code `cdhash:<hash>` and unsigned code `unsigned:`. No client is ever
  assigned `codesign:`, so a list containing only `codesign:` excludes codesign
  itself and its first use asks for confirmation. The minimal list is
  `[apple:]`. It excludes `security` (`apple-tool:`) and every non-Apple
  process, including `ctl`.
- **Signing ACL exactly `{/usr/bin/codesign, recorded ctl}`.** Every ACL
  entry that authorizes signing trusts `/usr/bin/codesign` and the `ctl`
  binary that provisioned the key, and nothing else. `ctl` must be in the
  initial ACL to sign the CSR. securityd refuses (`errSecAuthFailed`) a
  password-authorized edit that removes it, so it stays. It still cannot use
  the key, because its partition (`cdhash:…`) is outside `[apple:]`.
- **ACL record.** `provision-signing-key` records the exact `ctl` path that
  securityd stored in the new key's signing ACL. The guard checks that exact
  path, not a code hash; `[apple:]` is what blocks the non-Apple ctl from using
  the key. Unrecognized fields in older records are ignored. The
  record is `<K>.acl.json` (mode 0600, owned by the user), keyed by the
  public-key SHA-256. The guard compares against this record, never against a
  file name. A missing, loose (not 0600), foreign (naming another keychain) or
  keyless record fails with `invalid-input`. The provisioning `ctl` store path
  must stay live: the consumer roots it as a GC root. If it does not, the
  check still works, but the ACL entry names a path that no longer exists.
- **Codesign guard.** Before any signing `codesign` (in `install-host`,
  `sign-fixture` and `prove-signing-key`), `ctl` reads the key's ACLs inside the unlock window.
  It requires a partition-capable `K`, a partition list equal to `[apple:]` and
  signing ACLs equal to `{/usr/bin/codesign, recorded ctl}`. Anything wider or
  different fails with `verification-failed` and runs no `codesign`. Each
  signing, verify and detail `codesign` has a 30-second deadline, after which it is killed
  (`sign-timeout`). Production always executes the absolute
  `/usr/bin/codesign`, for signing and verification, never a PATH-selected
  executable. Only the separate `test-signing-cert` build selects a PATH
  shim, to inject signing failures and record arguments.
  Process waits and nonblocking stdout/stderr reads share that deadline and
  the signal self-pipe. Leader exit is observed without reaping (`waitid`
  with `WNOWAIT`), keeping its PID/PGID reserved until its whole process group
  is killed. Only then is the leader reaped, so descendants cannot retain pipes
  indefinitely. The final drain is bounded by one second and the remaining
  overall deadline; there are no blocking output-thread joins.
- **Certificate chain preflight.** Before codesign, `ctl` evaluates the
  identity's certificate with `SecTrust` and the code-signing policy.
  Network fetching is disabled; intermediates and trusted anchors must
  already be available through the normal system search list. A failed
  evaluation is `chain-incomplete`, before codesign can return an opaque
  `errSecInternalComponent`. Neither `K`'s search-list membership nor
  system trust is changed. For an Apple-issued signing certificate, the
  consumer makes the WWDR intermediate available in the system keychain;
  Apple's root is a system anchor.
- **Password by descriptor.** The consumer owns password retrieval (for
  example an op-proxy grant) and passes it on an inherited descriptor
  (`--keychain-password-fd N`). The password is the descriptor's bytes up to
  EOF with exactly one trailing `\n` removed; no other byte is trimmed, and
  provisioning must use the same bytes. Empty content, more than 1024 bytes,
  or no EOF within five seconds is `password-invalid`, decided before
  `SecKeychainUnlock`. The password is never accepted from argv or the
  environment and never passed to a child process.
  `ctl` reads it into a fixed buffer and zeroes the buffer after unlocking.
- **Auth pending is the consumer's decision.** The consumer decides from its
  password reader's exit status (with `pipefail` or equivalent), never from
  empty output alone. If the reader fails it passes `--signing-auth-pending`
  instead of a descriptor.
- **Lock discipline.** Every `install-host` run that names `K` first calls
  `SecKeychainLock(K)`, because a SIGKILLed run skips cleanup. The identity
  lookup and requirement canonicalization happen while `K` is locked.
  `SecKeychainUnlock` then opens a window for the codesign guard (in-process
  ACL reads), exactly one `codesign` of the staged bundle and its `codesign`
  verification; no other child process, network or op-proxy call runs inside
  it. A checked `SecKeychainLock` closes it before any signing result is used;
  if that lock fails the run fails with `relock-failed` and nothing is
  exchanged. Failures inside the unlock window also pass through a checked
  final lock before they are returned; relock failure overrides the original
  error. Destructors provide additional best-effort cleanup for unwinding.
  During the window, SIGTERM, SIGINT and SIGHUP (also SIGPIPE) wake a
  nonblocking self-pipe. The handler performs no keychain/framework calls.
  The owning thread kills the active codesign process group, reaps the child,
  runs the checked final lock and returns nonzero (`operation-failed`).
  SIGKILL cannot be handled; the next invocation's initial lock closes that
  interrupted window.
- **Never the login keychain.** A path that resolves to the login keychain,
  by name or by `security login-keychain`, is refused before it is opened.

### Signing-key provisioning

Three primitives establish the signer contract without `security(1)` and
without a password in argv. They take `--keychain K --keychain-password-fd N`
with the same descriptor rules and refuse the login keychain and
non-partition-capable locations. `ctl` disables keychain user interaction
process-wide (`SecKeychainSetUserInteractionAllowed(false)`), so any call of
its own that would need UI fails with `errSecInteractionNotAllowed` instead of
prompting.

For an existing `K`, all three provisioning primitives open and lock it before
reading passwords, certificate files or remaining operation arguments. A
newly created `K` is likewise locked before its provisioning window begins.
Every return path after opening `K`, including invalid input and keychain
operation failures, passes through a checked final `SecKeychainLock`; failure
is `relock-failed` rather than an apparently successful or safely failed
operation. This also closes a window left open by a previously killed process.

For file-based keychains, `SecKeyCreateRandomKey`'s CDSA branch reads the
top-level generation attributes; nested private/public attribute dictionaries
are not used there. Provision therefore sets `kSecAttrIsExtractable=false`
at the top level (public keys remain extractable). Provision and prove read
the actual `CSSM_KEYATTR_EXTRACTABLE` bit via `SecKeyGetCSSMKey`; the bit,
not the requested attributes, is the ground truth. Provision fails closed
with `verification-failed` unless the created private key is non-extractable
and the settings read back as lock on sleep and a 300-second interval.
`SecKeychainCopySettings` writes `lockOnSleep` and `lockInterval`, but does not
write `useLockInterval`; the interval's actual value determines the result.

| Primitive               | Arguments                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provision-signing-key` | `--common-name-hint CN --csr-out PATH [--replace]` | Creates `K` if absent (mode 0600, not added to the search list, not made default), sets auto-lock after 300 seconds and lock on sleep (`SecKeychainSetSettings`), creates a permanent, non-extractable RSA-2048 key (`SecKeyCreateRandomKey`) whose initial ACL trusts `ctl` and `/usr/bin/codesign`, records the stored `ctl` path in `<K>.acl.json`, and writes a PEM PKCS#10 CSR (subject `CN`) that `ctl` signs with the key (`SecKeyCreateSignature`). If `K` already holds a private key it refuses (`invalid-input`, listing them) unless `--replace` is passed. `--replace` adds a key, adds its record entry and reports `retainedPrivateKeys`; keys are never deleted. Reports `aclRecord` and `ctlPath`.                                                                        |
| `import-signing-cert`   | `--cert PATH` (PEM or DER)                         | Imports the certificate only if it pairs with a private key in `K` (`SecIdentityCreateWithCertificate` before `SecItemAdd`; otherwise `verification-failed` and nothing is imported), then confirms that `find-identity` sees the identity. Idempotent (`imported: false` on repeat). Reports `certificateSha1`, `subject` and `publicKeySha256`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `prove-signing-key`     | `[--no-sign]`                                      | Requires exactly one identity in `K` and its ACL record. While `ctl` can still use the key it attempts a PKCS#12 export of the identity (only if the key's attribute already says non-extractable) and expects refusal. It then sets the partition list to `[apple:]` in one ACL edit authorized in-process by the keychain password (`SecACLSetContents` + `SecKeychainItemSetAccessWithPassword`, the equivalent of `security set-key-partition-list` without argv). The signing ACL is not edited. Then it runs the codesign guard and, unless `--no-sign`, signs and verifies a throwaway file with `codesign` under the deadline. Finally it relocks `K`. A repeat run finds the guard already holds and skips the export attempt, because `ctl`'s partition is now outside the list. |

The export proof accepts only `errSecDataNotAvailable` (`-25316`), the
non-extractable key's PKCS#12 export refusal. Other failure statuses do not
prove non-extractability and fail verification.

The proof result has `partitionCapable`, `exportAttempted`, `exportStatus`,
`exportRefused`, `signOk` (`null` with `--no-sign`), `guardReady`,
`partitionList`, `signAclExact`, `recordedCtlPath`, `securityToolExcluded`,
`keyExtractable`, `lockedAfterWindow`, `lockOnSleep` and
`lockIntervalSeconds`. It fails with `verification-failed` unless `K` is
partition-capable, the guard holds, export is refused, the key is
non-extractable, `K` is locked after the window and (without `--no-sign`)
codesign signed and verified. `securityToolExcluded` is structural: `security`
runs as `apple-tool:`, which the exact `[apple:]` list excludes. No `security`
export or lookup is run against the pinned key, because a partition miss would
ask for confirmation. Refusal while locked is likewise recorded as
`lockedAfterWindow` rather than by attempting a locked use, which would ask
to unlock.

The consumer runs these primitives once per signer: provision, have the CSR
issued, import, prove. Its verify steps then rely on `install-host`'s guard.
The proof for the production keychain in `~/Library/Keychains/` is recorded by
running `prove-signing-key` during rollout. The integration suite proves the
same properties on throwaway keychains under `tmp/<work>/Library/Keychains/`.
Its separate `test-signing-cert` build issues self-signed code-signing leaves
with the non-extractable key before pinning it. The shipped binary neither
compiles nor accepts `--test-self-signed-cert-out`. The test build uses a
self-issued leaf as an anchor only for its ephemeral `SecTrust` evaluation,
never adding system trust or changing a keychain search list. A CA-issued
test leaf without a system anchor is a negative case (`chain-incomplete`,
no codesign).
The harness observes a zero SecurityAgent window baseline and aborts on changes.
If CGWindowList is unavailable, it accepts only an audit session whose graphics
and console-access flags are both absent, rechecked before and throughout every
keychain child. It reports that evidence as a no-UI session, never as zero windows;
an unavailable observer in a UI-capable session aborts before keychain operations.
Observer and audit failures during a child run kill the entire child process
group and reap its leader before aborting or deleting any throwaway keychain.
The transient ctl anchor does not make the test identity trusted by the codesign
child. In no-UI mode the harness proves that the fixture identity exists but is
`CSSMERR_TP_NOT_TRUSTED`, runs refusal and non-signing cases, and explicitly
prints `NOT RUN: untrusted test identity in no-UI session` for positive fixture
signing, the codesign key proof and dependent host-signing cases. Exit zero means
only that every case run passed; positive signing remains unverified. The default
GUI mode still runs the full suite. Positive-path proof requires a human-present
session with an appropriately trusted test identity; the harness never bootstraps
trust or treats that prerequisite as a passing signature test.

### Fixture signing and agent process rules

Agents sign only through `ctl`, including test and fixture bundles. Use
`sign-fixture --keychain K --keychain-password-fd N --certificate-sha1 SHA1
--requirement REQ --target APP [--inventory FILE]` with the usual `--config`.
It reads back non-extractability, performs the password-authorized partition
pin preparation, and runs the exact ACL guard and trust-chain preflight before
spawning codesign. A missing or foreign ACL record refuses before preparation;
other unsafe ACLs refuse before codesign. The password never reaches a child.
Once the dedicated keychain path is validated, ctl opens and locks it before
validating the remaining fixture inputs. Input failures therefore relock a
previously interrupted signing window and pass through the checked final lock.
The optional inventory is a JSON array of relative nested-code paths beneath
the target. Entries are canonicalized and checked for containment, deduplicated,
then signed deepest-first before the outer target, without `--deep`. Each
signature is verified against the supplied requirement.

The accepted residual is that invoking `/usr/bin/codesign` or `/usr/bin/security`
by absolute path bypasses host PATH wrappers. This is covered by agent process
rules, not technical enforcement: wrappers are not a sandbox. Production ctl
does not accept runtime overrides of its codesign executable; only the separate
test-feature build admits the recording/sentinel shim.

### Opt-in real-launchd smoke

From a Darwin checkout, `nix run .#macos-app-launchd-smoke --option builders
'' --option max-jobs 2` runs a feature-gated Rust acceptance runner against
the real system `launchctl`. This is a live, user-level smoke, not the fake
launchctl integration suite: macOS may show a background-item notification.
It never uses sudo or launches an application window.

The launchd label is per user, so every checkout serializes on one exclusive
per-user lock, `dev.overeng.macos-app.smoke.lock` in the Darwin per-user temp
directory (`confstr(_CS_DARWIN_USER_TEMP_DIR)`). Children inherit the lock, so
an orphan of a killed run keeps it until it exits. Only under that lock does
the runner sweep what a killed run left: a `dev.overeng.macos-app.smoke` job
is booted
out only when `launchctl print` shows it was loaded from a
`tmp/macos-app-smoke-*` plist (any other job under the label is refused), and
stale `tmp/macos-app-smoke-*` scratch directories are removed.
`-- --sweep-only` runs just this sweep. After the sweep, the label must be
absent in both domains.
All bundles,
plists, generation pointers, GC roots and the partition-capable test keychain
live beneath its private `tmp/` directory; the password travels through an
inherited pipe, not argv, environment or a file. The test-only self-signed
certificate does not change system trust, the login keychain or the search
list. A zero-SecurityAgent-window pre-call guard and live tripwire abort the
run on any signing prompt.
Only public UID-adjusted generation manifests are imported with `nix-store
--add`; selection roots their immutable store paths. No signing material
enters the store.

It installs/selects/converges/verifies a background agent in `user/<uid>`,
then checks wire status against both the selected generation and the domain's
real audit-session API result. It proves generation-only switching preserves
PID, signed host bytes and cdhash; no-op convergence preserves filesystem
contents/inodes/mtimes; generation rollback works; a host metadata change
re-signs; and host rollback restores the original signed bytes and generation.
When a graphic-access GUI domain exists it repeats with `gui-agent` in
`gui/<uid>`, using the same windowless `LSBackgroundOnly` generic host;
otherwise GUI coverage is explicitly skipped.
The runner passes an explicit `--domain user` or `--domain gui`; it does not
use background-agent's auto resolution, which prefers GUI on interactive hosts.

After the absent-label guards, success and failure cleanup boot out the smoke
label in both existing user and GUI domains, independent of the run's
returned domain, and wait up to 10 seconds per domain for `launchctl print` to
report exit 113. Cleanup attempts every domain and the removal of the plist,
bundle, state, socket and keychain even after an earlier step fails, then
exits nonzero naming what was left behind. SIGINT, SIGTERM and SIGHUP stop the
in-flight child's process group and run the same cleanup; SIGKILL cannot, so
the next run's sweep handles it. Scratch ownership is logged in
`tmp/TEMPORARY_FILES.md`.

`nix run .#macos-app-launchd-smoke -- --signal-matrix` exercises this
against real launchd. It interrupts runs with SIGTERM, SIGINT and SIGHUP once
the user-domain job is loaded and proves cleanup for each. It then SIGKILLs a
run, confirms the job and scratch were left behind, and requires the next full
run to sweep both and pass.
