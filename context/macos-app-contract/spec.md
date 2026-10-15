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
  panel. Each product has one outer bundle ID and pinned DR; declared nested
  code objects have their own explicit signing identities and predicates.
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

- effect-utils owns the generic convenience host, the Nix builder, install/seal
  primitives, the existing IPC schema and a shared Rust security library.
- Consumers own product declarations, signing identities, activation-bundle
  integration, migrations and grants.
- The contract does not cover CLIs without a consent identity.
- Complete native bundles are first-class inputs. Product business runtimes,
  authentication policy, XPC/descriptor transports and activation orchestration
  remain product-owned. This scope promises no C ABI, generic resident manager,
  new product-generation protocol or replacement control-wire schema.

## Unsigned builder and host

`effectUtils.lib.mkMacosApp { pkgs, name, bundleId, displayName, session,
launchd, signer, statusAllowedUids, actions, host ? null, hostBundle ? null,
requirement ? <new-identity default>, lifecycleLockPath ? null, socketMode ? 438 }`
returns `hostApp`, `generation`, `requirement`, `hostSourceHash`,
`desiredDescriptor`, `ctl`, `ctlConfig` and `primitives`. The minimal constructor
puts the host executable, product-specific Info.plist and
`Contents/Resources/host-source-hash` in `hostApp/<name>.app`.
`hostBundle` instead supplies a complete unsigned native `.app`; it is mutually
exclusive with `host`. Product builders retain ownership of bundle assembly.
Neither input has a product signature; an execution-required ad-hoc toolchain
seal is not a product identity. External action/payload changes replace the
existing generation without changing host bytes.
`desiredDescriptor` is generated by the same ctl `describe-host` implementation
used for sealing/import. Generic `hostSourceHash` covers runtime Rust sources
and Cargo metadata; complete bundle bytes and policy are covered separately
by the descriptor's `hostRevision`.

| Option              | Values                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`           | `gui-agent`, `background-agent` (default), `system-daemon`. Only `gui-agent` clears `LSBackgroundOnly`.                                                                                                                          |
| `launchd`           | `{ label; keepAlive ? true; runAtLoad ? true; extra ? { } }`. `extra` keys are limited to `AssociatedBundleIdentifiers`, `ProcessType`, `ThrottleInterval`, `StandardOutPath`, `StandardErrorPath`, `WorkingDirectory`, `Umask`. |
| `signer`            | `{ teamId; identity; }`. `identity` is a certificate name or SHA-1, never key material and never `-`.                                                                                                                            |
| `host`              | `null` selects the generic host. A product-supplied host is a package with `meta.mainProgram` and a `hostSourceHash` attribute; it must be product-data independent and answer the wire `status` action with that hash.          |
| `requirement`       | Explicit pinned code requirement for an incumbent identity; the default below is only appropriate for a genuinely new identity.                                                                                                  |
| `hostBundle`        | `{ path; executable; hostSourceHash; nestedCode ? []; entitlements ? null; signingOptions ? []; }`. `path` names the unsigned `.app`; `executable` is its relative native entrypoint.                                            |
| `lifecycleLockPath` | `null` for unprotected legacy callers, or the explicit absolute private lock-file path; configured mutations require `--lifecycle-fd`.                                                                                           |

The new-identity default for `requirement` is `identifier "<bundleId>" and
anchor apple generic and certificate leaf[subject.OU] = "<teamId>"`.
Incumbent predicates remain explicitly pinned; do not substitute an OU
predicate for a CN predicate or vice versa. Security.framework compiles the
predicate and evaluates actual code against it. Printed/canonical requirement
text is diagnostic, not an equality or compatibility oracle. Concrete
two-way incumbent/candidate checks can provide compatibility evidence but do
not establish general logical equivalence or grant survival.

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

## Complete bundle descriptors and sealed releases

```text
unsigned APP + independently pinned ctl config
  -> describe-host -> unsigned descriptor (hostRevision)
  -> seal-host    -> RELEASE/host.app + descriptor.json + receipt.json
  -> install-host --desired DESCRIPTOR --artifact RELEASE
                     verification only -> installed native app
```

The ctl configuration keeps `requirement`, `hostExecutable` and `bundleId`
at the top level. `nestedCode` is an explicit array of
`{ path, identifier, requirement, entitlements?, options }`; paths are relative
to the outer app. Outer policy uses `entitlements` and `signingOptions`.
Entitlements name immutable plist inputs; descriptor policy records their
content digests. Reject duplicate/escaping inventory paths, undeclared code,
identity overrides and unsafe writable layouts. Never infer policy with
`codesign --deep`. Declared nested objects are signed deepest-first with their
own identifiers, requirements, entitlements and options, then the outer app.

`describe-host --desired APP` is unsigned and deterministic; it does not
open a keychain, sign, install or invoke launchd. Its descriptor has
`schema: "macos-app-unsigned"`, `version: 1`, `policy`, `files` and
`hostRevision`. `policy` contains `mainExecutable` and ordered `objects`;
each object has `path`, `identifier`, `requirement`, `entitlementsSha256`
(`null` or a digest), and sorted `options`. Outer object path is `""`, last.
`files` is path-sorted, with `path`, `kind` (`directory` or `file`),
`executable` and `sha256` (`null` for directories). Unsigned normalization
removes Mach-O signature envelopes and declared code-signature resources,
not ordinary sealed resources. `hostRevision` is SHA-256 of canonical
descriptor JSON without that field.

`seal-host --desired APP --output RELEASE --keychain K
--keychain-password-fd N` only signs. It enforces the existing dedicated
keychain, ACL, non-extractability, partition and trust-chain rules, verifies
each declared signature against its compiled predicate, and publishes an
immutable release containing exactly `host.app`, `descriptor.json` and
`receipt.json`. An existing valid release matching desired content and policy
is reused without re-signing; an invalid or mismatching output is refused,
not overwritten. No installed app, generation or launchd state changes.
Sealing copies into a unique mode-0700 staging directory owned by the sealing
UID, and checks that staged unsigned content equals the pinned descriptor
before any signing operation. A source change during copying refuses before
the signing key is used; receipt validation repeats the content check afterward.

The receipt has `schema: "macos-app-release"`, `version: 1`, `hostRevision`,
`sealedRevision` and `files`. These file records hash actual sealed bytes,
including signatures; `sealedRevision` hashes their canonical JSON.
The compiled `hostSourceHash`, complete unsigned `hostRevision`, actual
`sealedRevision` and generation digest are separate evidence. The source
marker alone cannot attest resources, nested code or the complete release.
A receipt is an integrity inventory, not signature attestation or an
authority to choose desired identity.

Artifact installation uses `install-host --desired DESCRIPTOR --artifact
RELEASE --app-dir D --state S --archive-dir R [--lifecycle-fd N]`.
The desired descriptor is independently consumer-pinned, not selected from
the release. ctl validates descriptor/content/policy correspondence, receipt
bytes and all signatures before exchange. This path accepts no credentials
and has no signing fallback. It supports user or root destinations; app and
archive locations must permit the same-filesystem exchange. Incumbents are
retained immutably in consumer-selected `R`, never pruned by ctl. Invalid
imports leave the incumbent untouched. The local-signing `install-host
--desired APP` path below remains backward compatible and separate.

### Incumbent policy during artifact cutover

| Installed bundle's config record                | Incumbent validation before replacement                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Present at `S/host-configs/<bundle-inode>.json` | Describe the incumbent using its recorded configuration and verify its recorded outer and nested signature policy; also require its outer identity to satisfy the candidate's pinned identity.                            |
| Absent, default invocation                      | Describe and verify the incumbent using the candidate configuration, including its complete bundle layout and signature policy. A layout or policy mismatch fails closed.                                                 |
| Absent, explicit `--incumbent legacy`           | Check the outer Info.plist `CFBundleIdentifier` equals the candidate's configured `bundleId`, verify the outer code signature strictly, and evaluate the candidate's pinned outer `requirement` against that actual code. |

`--incumbent` is a typed CLI policy whose only accepted value is `legacy`.
It is accepted only for `install-host --artifact` and `rollback --artifact`;
other values and use with local-sign installation or other primitives are
invalid input. Omission retains the default checks above. A consumer explicitly
opts in when adopting an unrecorded legacy bundle whose layout differs from
the candidate, for example:

```sh
"$ctl" install-host --artifact "$release" --desired "$descriptor" \
  --app-dir "$app" --state "$state" --archive-dir "$archives" \
  --incumbent legacy --lifecycle-fd "$lifecycle_fd"
```

The legacy exception checks identity, not compatibility with the candidate's
executable path, nested inventory, entitlements or signing options. It does not
skip strict outer signature validity or authorize a different bundle identifier
or pinned signing identity. It does not prove historical grant continuity.
Candidate descriptor, receipt, content and signature checks remain unchanged.

Before publishing an artifact-installed bundle, ctl durably records its
configuration at `S/host-configs/<bundle-inode>.json`, keyed by that bundle's
inode. Later replacement uses that recorded configuration to describe and
verify the incumbent's own layout and signatures, rather than imposing the
new candidate's layout on it. The candidate's pinned outer identity must still
match the incumbent. An existing invalid record or a failure under its policy
is a refusal, never a reason to retry as legacy; `--incumbent legacy` cannot
bypass a record. The consumer retains these records with the state needed for
its installed and archived bundles.

This is an invocation policy, not a Nix constructor or configuration option.
The existing `ctl` wrapper forwards consumer arguments unchanged; the Nix
interface and generated `ctlConfig` schema do not change.

Artifact `verify --artifact RELEASE --desired DESCRIPTOR --app-dir D
--state S --generation G` checks the installed descriptor and actual
`sealedRevision` against the pinned release, and compares the selected
`generationDigest`. Optional supplied-plist inputs add read-only loaded and
running evidence; they do not mutate launchd.

Artifact rollback uses `rollback --artifact RELEASE --desired DESCRIPTOR
--generation G --app-dir D --state S --archive-dir R [--lifecycle-fd N]`.
The consumer selects the exact retained artifact/generation pair; ctl never
chooses a latest-successful release or prunes archives. It verifies/imports
that release and selects the supplied generation. Supplied-plist inputs can
converge and verify the job. Without a plist it reports `restartRequired:
true`, not a claim that the process restarted. Legacy `--restore-host`
rollback and its primitive-scoped crash journals below remain available.
The same incumbent policy applies when artifact rollback replaces the currently
installed bundle; `--incumbent legacy` is an explicit option there too, and
never relaxes validation of the selected rollback artifact or a recorded
incumbent.

## Install primitives

`ctl` (`bin/macos-app-ctl`) is a nonresident Rust executable built beside the
host. It carries the product's `ctlConfig` and is never launchd's Program, so
the TCC subject stays the host. The consumer's activation-bundle framework owns
the per-product state machine (desired state, stamps, holds, pins, GC policy,
serialization) and calls one primitive per step:

| Primitive           | Arguments                                                                                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-host`      | `--app-dir D --state S --desired APP (--keychain K --keychain-password-fd N \| --signing-auth-pending)` | Legacy local-sign path: reconciles interrupted install/rollback first. No-op when marker and Info.plist digest match, strict signature verification passes and installed code satisfies the configured requirement. Otherwise stages/signs/verifies, journals `D.txn.json`, exchanges with `D`, records the incumbent generation and publishes `D.previous`. Reports `reconciled` and `leftovers`. The artifact path above adds complete-content verification without credentials.                                                                                                                                                                                                                                                            |
| `select-generation` | `--state S --generation G`                                                                              | No-op when `S/current` already points to `G`. Otherwise roots `G` with `nix-store --add-root S/roots/<sha256(G)> --indirect`, or records `S/roots/<hash>.path` and reports `consumerRootRequired` when `nix-store` is absent; moves the old pointer to `S/previous`; atomically replaces `S/current`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `converge-launchd`  | `--app-dir --state --socket --plist-dir P [--domain auto\|gui\|user\|system]`                           | Renders `P/<label>.plist` with `Program` = the host executable inside `D` and `serve --socket … --generation-pointer S/current` arguments. No-op (read-only `launchctl print` probes only) when the bytes are equal, the job is loaded, the running host reports the installed host hash, `S/launched-app-inode` equals the inode at `D` and the socket mode equals the active generation's `socketMode`. A plist, host or bundle exchange (including metadata-only) causes `bootout` (if loaded), `bootstrap` and a new `S/launched-app-inode`. A `socketMode` change alone causes `launchctl kickstart -k` and reports `restart: "socket-mode"`. Any other generation-only change never restarts: the host rereads the pointer per request. |
| `verify`            | `--app-dir --state --socket --desired APP --generation G`                                               | Installed code satisfies the configured compiled requirement; marker and metadata match desired, `S/current` equals `G`, socket mode matches, and IPC status reports the expected host hash, generation and launchd PID. This legacy convenience-host contract does not establish a native product's business-process or grant continuity.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rollback`          | `--app-dir --state --socket --plist-dir [--restore-host]`                                               | Resumes a pending `D.rollback.json` first, whatever the flag. Without `--restore-host`, a generation rollback: points `S/current` at `S/previous` and converges (no restart unless `socketMode` differs). With `--restore-host`, a host-only rollback that the consumer passes when its own record shows the host was swapped (below). Both finish with `verify`.                                                                                                                                                                                                                                                                                                                                                                             |
| `status`            | `--app-dir --state --socket`                                                                            | Host hash, bundle-metadata digest, DR validity, active and previous generation, `hostArchive`, `hostArchiveGeneration`, `interruptedTransaction`, `interruptedRollback`, socket mode, launchd domain/loaded/PID, session (`gui`, `background-only`, `no-session`), `signingFailure` marker and the running host's IPC status.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Consumer lifecycle exclusion

Every mutating verb accepts `--lifecycle-fd N`, including key provisioning,
import/proof and fixture signing; sign-only `seal-host` is the exception.
`lifecycleLockPath` pins the absolute lock-file path in ctl configuration.
A configured path requires the descriptor on mutations; legacy unprotected
configuration leaves it null. The inherited fd must refer to that path's
device/inode and a private, singly linked regular file owned by the current
effective UID, under protected no-follow ancestry without ACL grants.

ctl takes `flock(LOCK_EX | LOCK_NB)` on the inherited open-file description.
An already held exclusive lock succeeds trivially; a competing file description
refuses with typed `restart-deferred`. An unlocked inherited description can
acquire exclusion. ctl retains its descriptor through the entire mutation and
marks inherited descriptors close-on-exec so spawned commands do not prolong it.

**Residual: acquire-present-exclusive is not proof of a previously held interval.**
Darwin's [XNU flock implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_descrip.c)
exposes set/unlock, not a non-acquiring same-description ownership query.
The consumer must cover its preceding pre-checks and preserve the lock inode.
Product admission takes shared exclusion before capturing the generation and
holds it for the operation. Receipt-lock ordering remains consumer-owned;
no conflicting upgrade, generic drain or kill fallback is introduced.
A selected generation is not proof that an active invocation changed its pin.

### Consumer-supplied launchd plists

The existing generated-plist path remains a convenience. A consumer supplies
one protected plist per invocation with `--plist P --domain
system|gui/UID|user/UID --target-uid UID --evidence resident|scheduled`,
plus `--app-dir D` and the existing state/plist-directory inputs.
UID is mandatory canonical decimal consumer input, never inferred from root
or the current console user. Domain UID must agree. Existing session
constraints still apply: GUI agents require `gui/UID`, background agents use
`gui/UID` or `user/UID`, and system daemons use `system`.

`converge-launchd ... --validate-only` validates offline and performs no
launchctl, signature/keychain or live-session probes. Offline still entails
protected-file reads, local account resolution and `plutil` parsing.
Validation preserves the exact input bytes, checks the configured label,
direct installed native entrypoint and matching `Program`/`ProgramArguments[0]`,
and rejects reserved identity/domain overrides. The convenience generic host
must have exactly its closed `serve --socket ... --generation-pointer ...`
argv; native product argument contracts remain product-owned.
Input, installed entrypoint and ancestors must be normalized absolute paths,
non-symlink, owned by root or the target UID, not group/world writable, and
without granting or unknown ACL entries. Descriptor-relative no-follow opens
check ACLs on every ancestor and the final input; deny-only ACLs remain valid.
The entrypoint is an executable regular file. System `UserName`/`GroupName`
must match the target account and primary group; a non-root system target
requires `UserName`.

Ordinary calendars, environment, KeepAlive, MachServices and other launchd
keys remain consumer-authored opaque launchd configuration. ctl does not add
a parallel launchd DSL. `resident` requires running evidence; `scheduled`
allows a loaded idle job with running absent and must not kickstart it merely
to manufacture PID evidence. Configured/loaded plist evidence is distinct
from actual running identity; a historical completion receipt is not a
running-process attestation. Missing GUI is a structured non-mutation result.

Offline validation reports `validated: true`, `changed: false`, `loaded:
false`, `running: null`; these are not live loaded-state evidence.
Live resident proof requires an authenticated `--socket` kernel peer whose
PID matches launchctl's observed PID. A scheduled job may be loaded idle
with `running: null`; an observed running PID without authenticated socket
evidence is explicitly unauthenticated. launchctl's reported PID alone is
not an authentication token.

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

Legacy generated-plist domain resolution, for `auto` and explicit aliases:

| Session            | Allowed `--domain`    | Resolves to                                                              |
| ------------------ | --------------------- | ------------------------------------------------------------------------ |
| `gui-agent`        | `auto`, `gui`         | `gui/<uid>` when `launchctl print gui/<uid>` succeeds, else `gui-absent` |
| `background-agent` | `auto`, `gui`, `user` | `auto`: `gui/<uid>` when present, else `user/<uid>`; `gui` requires it   |
| `system-daemon`    | `auto`, `system`      | `system`                                                                 |

Any other combination is `invalid-input` before any `launchctl` call. There is
no fallback to broader `launchctl` operations.

The legacy generated-plist path derives `LimitLoadToSessionType` from kind and resolved
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
  `seal-host`, `sign-fixture` and `prove-signing-key`), `ctl` reads the key's ACLs inside the unlock window.
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
- **Lock discipline.** Every local-sign `install-host` and `seal-host` run
  that names `K` first calls `SecKeychainLock(K)`, because a SIGKILLed run
  skips cleanup. Identity lookup and requirement compilation happen while
  `K` is locked. `SecKeychainUnlock` then opens a window for the codesign
  guard (in-process ACL reads), declared nested signatures followed by the
  outer bundle signature and their verification. No unrelated child
  process, network or op-proxy call runs inside
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
only that every case run passed; positive keyed signing remains unverified.
The harness refuses graphics/console-capable audit sessions before operations.
Positive keyed proof needs a separately authorized trusted test identity; the
harness never bootstraps trust or treats that prerequisite as a passing test.

### Fixture signing and agent process rules

Agents sign only through `ctl`, including test and fixture bundles. Use
`sign-fixture --keychain K --keychain-password-fd N --certificate-sha1 SHA1
--identifier ID --production-requirements FILE --target APP [--inventory FILE]`
with the usual `--config`. `ID` must be in `dev.overeng.macos-app.fixture.` with
a nonempty identifier-character suffix. Every signed item gets that explicit
codesign identifier, overriding bundle metadata. ctl constructs the requirement
as `identifier "<ID>" and certificate leaf = H"<SHA1>"`; caller-supplied
requirements and identifiers outside the fixture namespace refuse before unlock.
This keeps fixture code outside production designated requirements and their TCC
grants, even when host and fixture keychains are controlled by the same account.

The certificate must be explicitly allowlisted by `<K>.fixture-identity.json`,
a regular 0600 file owned by the current user, naming K and its fixture
certificate SHA1, subject and public-key SHA256. Only deliberate test-feature
provisioning with `--test-self-signed-cert-out` writes this record; production
provisioning never does. The record is only an allowlist, not an authority for a
certificate's subject or key. Before unlocking, ctl reads actual certificate
SHA1s, subjects and public keys from the locked keychain. It rejects the configured
production identity by actual SHA1/subject and rejects a different certificate for
that production key by actual public-key hash. The selected certificate's actual
public-key hash must also match the allowlist. Forging the sidecar subject cannot
authorize a production signer. Missing/foreign records and unlisted SHA1s also
refuse before unlock. Each product ctl config pins one production requirement,
not a repository-wide product inventory, so the mandatory
`--production-requirements` file supplies that inventory as a JSON array of DR
strings. ctl adds its configured product requirement and refuses a canonical,
compiled-identical match before unlock. This comparison is not general predicate
equivalence. The inventory must enumerate all
production DRs the caller protects.

The same shared helper as `prove-signing-key` reads back non-extractability and
requires export refusal `errSecDataNotAvailable` (-25316) before pinning. A key
already passing the exact pin/ACL guard uses its non-extractable readback instead,
because attempting export from ctl's excluded partition could request approval.
The signer then performs the password-authorized partition
pin preparation, and runs the exact ACL guard and trust-chain preflight before
spawning codesign. A missing or foreign ACL record refuses before preparation;
other unsafe ACLs refuse before codesign. The password never reaches a child.
Once the dedicated keychain path is validated, ctl opens and locks it before
validating the remaining fixture inputs. Input failures therefore relock a
previously interrupted signing window and pass through the checked final lock.
The optional inventory is a JSON array of relative nested-code paths beneath
the target. Entries are canonicalized and checked for containment, deduplicated,
then signed deepest-first before the outer target, without `--deep`. Each
signature is verified against the ctl-constructed fixture requirement.

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

## Shared native security support

The Rust library exposes `CompiledRequirement::compile(&str)` and
`verify_path(&Path)`. Verification uses Security.framework's actual compiled
predicate, strict nested/all-architecture validation and offline evaluation,
not codesign diagnostic text equality.
`authenticate_token(AuditToken, PeerPolicy)` and
`authenticate_peer(&UnixStream, PeerPolicy)` combine authorized effective and
real UIDs with the caller's compiled code predicate. Tokens must originate
from the kernel transport (`LOCAL_PEERTOKEN` for Unix sockets), never from a
request's claimed PID or JSON token. Authentication uses the audit token for
code lookup and process freshness; recheck freshness immediately before
admission. Native liveness, parent binding, server policy and business
dispatch remain product responsibilities. A shared primitive does not prove
any product's end-to-end authorization flow.

`endpoint::bind` with `EndpointPolicy { owner_uid, socket_mode }` returns a
listener and cleanup guard. It validates no-follow ancestors, root/selected
ownership, absence of unsafe writable ancestry and ACL grants, and an owned
non-shared final parent. Root-owned sticky ancestors are allowed only above
protected owned children. It rejects live listeners and non-sockets. A stale socket is removed
only after `ECONNREFUSED` and a same-inode check; cleanup likewise must not
unlink a replacement. Native startup calls this helper so ephemeral parents
can be recreated after boot; activation-only mkdir is not endpoint safety.
ACL checks permit deny-only entries (including a home directory's default
deny-delete ACL), but reject allow or unknown entries.
The generic host resolves legacy relative socket arguments before this check.
The resolved absolute path must fit Darwin's Unix-socket address limit;
symlinked or unsafe writable ancestors are now refused rather than trusted.
`endpoint::verify_acl_no_grants(&File)` exposes that check;
`endpoint::validate_directory(&Path, owner_uid)` checks existing destination
and ancestry as a snapshot, not proof of mutation exclusion.
There is no C ABI compatibility promise in this scope.

## Evidence limits and residuals

This six-item delta adds pinned requirements, complete bundle policy,
unsigned/sealed descriptors, keyless artifact installation, supplied-plist
validation, lifecycle-fd exclusion and reusable Rust security primitives.
It does not implement the broader product-generation/control-wire redesign
or migrate any business runtime, grant or production service.

- Positive keyed signing is **NOT RUN** in a no-UI session when the
  self-issued test leaf is untrusted. Transient in-process trust does not
  trust the codesign child. Refusal/non-signing cases are not a substitute
  for positive sealing/import/signature proof.
- Tests call `no_ui_session()` before every keychain/codesign call and fail
  closed when proof is unavailable or UI access appears. No local key
  signing or real launchd loads are part of this delta's source-edit work.
  Fake launchctl tests establish fixture behavior only; the opt-in smoke
  above describes an executable test, not evidence that it ran.
- Grant survival across live migration and rollback is **NOT RUN**. Matching
  identifiers, passing compiled predicates and matching artifact digests do
  not prove historical TCC continuity or any protected operation.
- Root installation is **NOT RUN** unless explicitly authorized on a remote
  disposable target. User-level source/refusal cases do not establish root
  ownership, reboot behavior or root/non-root mutual authentication.
- Consumer-held exclusion must integrate with each native product's
  admission and existing receipt-lock order. ctl lock-fd validation alone
  is not evidence that cancel/disconnect cannot reopen work or that a
  product pins captured generations correctly.
- Offline plist validation does not prove real scheduled-job idleness,
  loaded-state no-op behavior, MachService registration, login routing or
  background-item notification behavior.
