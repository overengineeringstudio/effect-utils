# macOS app contract: single permissions host

This document specifies one stable permission-bearing host and its client and
release contracts. It builds on the accepted
[single-host decision](./.decisions/0001-single-permissions-host.md).
This directory has no separate vision or requirements document.

## Status

Draft. The single-host runtime and operations described here are the target
contract, not a claim that the current generic action runner implements them.
Existing `mkMacosApp`, `macos-app-ctl`, sealed-release and native security
primitives are reusable implementation inputs. No production grant or tool
migration is established by this document. Platform release gates are listed in
[open-questions.md](./open-questions.md).

## Scope

The contract defines host identity, typed operations, local IPC, policy, audit,
consent, assembly and migration. Changing CLIs, native apps, tray apps and agents
are clients; they do not acquire the host's grants themselves.

It does not define arbitrary execution, shell/script evaluation, caller-selected
plugins, an arbitrary filesystem proxy, root privilege escalation, a universal
permission-inheritance container, MDM deployment, or automatic TCC modification.
Product UI and business orchestration remain outside the protected host unless
reviewed as a specific host operation. A common installer over independently
consented product apps does not satisfy the single-host contract.

## Host process and ownership

```text
effect-utils (public)                 consumer repo
runtime + IPC + audit + Nix module -> config + private operations
          + generic operations       -> assemble unsigned single app
                                     -> seal -> install -> launchd
clients (same UID, local or SSH) ------typed IPC------> signed host
                                                   -> protected API
                                                   -> bounded result + audit
```

One consumer-assembled app holds all grants its operations need. Its fixed
consumer display name is **Mac Permissions Host**; the public implementation
uses the generic technical executable name `macos-app-host`. The consumer pins
its bundle identifier, display name, install path, launchd label and designated
requirement before the first grant. Renaming the consent identity is a deliberate
re-consent migration, not an ordinary upgrade.

launchd starts the installed signed native entrypoint directly, never a resident
shell, resource-accounting wrapper or client. A socket/SSH client does not launch
a replacement host when the service is absent. GUI-dependent operations require
the host's GUI session; absence returns `session-unavailable`, not a fallback to
another privileged app. Root-daemon integration is unresolved (DQ7), not implicit
permission to create a second consent identity.

Protected APIs and policy execute in the host. Compiled, reviewed operations are
not external action commands. A later operation may encapsulate a specifically
reviewed pinned worker only after its platform gate succeeds; the client cannot
choose the executable, argv, environment, working directory or inherited file
descriptors. This exception does not introduce an execution API.

### Public runtime and private assembly

| Owner         | Contents                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| effect-utils  | Host runtime, typed IPC and clients, audit machinery, Nix module, generic operations and their schemas/policy validation                                       |
| Consumer repo | Folder/source allowlists, caller labels, local state destinations, private operations, enablement, final app assembly, pinned identity, signing and activation |

A generic operation is added by an effect-utils PR defining schemas, policy,
required grants, audit metadata, cancellation/commit behavior and tests. After it
lands, the consumer repins effect-utils, enables/configures the operation,
assembles and seals a new host release, verifies it and obtains any new category
or Automation-target consent. New clients using an existing enabled operation
require neither a host identity nor a permission grant. Private operations link
into the same assembled host and receive the same whole-disk-authority review;
private configuration, source paths and labels never enter the public repo.
No dynamically loaded client code bypasses assembly and sealing.

## Typed operation registry

```text
compiled operation ID + version
  -> request/response/error schemas
  -> permission/session requirements
  -> immutable consumer policy
  -> reviewed native implementation
  -> audit projection + lifecycle/commit rules
```

The registry is compiled into the assembled host; startup rejects duplicate
ID/version pairs, invalid policy and enabled operations without implementations.
A manifest cannot add behavior the host does not implement. One schema source
derives host decoding and client types; unknown fields are rejected rather than
passed to a command. Status advertises enabled ID/version pairs and policy
revision, not executable paths or private source configuration.

Operation IDs are repository-local protocol names, stewarded by effect-utils:
`[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*`. `core.*` is reserved for public operations;
`private.*` is allocated only by the assembling repo and is not interoperable
across consumers. Examples: `core.copy-allowlisted`, `core.notify`,
`private.archive-import`; invalid: `Core.Notify`, `notify`, `core.exec` (forbidden
semantics despite valid spelling). There is no registered Internet namespace.
`operation` selects semantics; `operationVersion` selects its positive-integer
schema version. Breaking changes get a new version, never reinterpret an old
request. Host upgrades may retain supported versions explicitly; unsupported
versions return `unsupported-version` without work. Protocol framing has its own
`protocolVersion`; it is not an alias for the operation version.

### Request and response envelopes

```typescript
type Request = {
  protocolVersion: 1
  requestId: string // caller correlation only; 1..64 ASCII [A-Za-z0-9_-]
  operation: string
  operationVersion: number
  callerLabel: string // asserted, unauthenticated; 0..128 UTF-8 bytes
  input: CopyInput | NotifyInput // selected by operation + operationVersion
}
type Response =
  | { protocolVersion: 1; requestId: string; ok: true; result: CopyResult | NotifyResult }
  | {
      protocolVersion: 1
      requestId: string | null
      ok: false
      error: { code: ErrorCode; message: string; auditId: string | null }
    }
type ErrorCode =
  | 'invalid-request'
  | 'unsupported-version'
  | 'unknown-operation'
  | 'caller-denied'
  | 'policy-denied'
  | 'permission-required'
  | 'session-unavailable'
  | 'busy'
  | 'deadline-exceeded'
  | 'audit-unavailable'
  | 'operation-failed'
```

Every operation supplies concrete input/result schemas and bounded public error
messages. The envelope above is the target operation protocol, not the existing
[`wire.schema.json`](../../nix/macos-app/wire.schema.json) ctl/status wire. Keep
control status distinct; migrate callers rather than silently reinterpreting old
action requests. Request IDs are not authentication or a generic exactly-once
guarantee. A disconnect can leave an outcome unknown; clients must not blindly
retry mutations. Each operation defines replay, commit and result-query behavior.

## IPC and same-user trust

```text
accept -> kernel peer -> same-user admission -> bounded decode
       -> registry/version -> operation policy -> audit admission
       -> execute -> audit outcome -> response -> close
```

Use a local Unix-domain socket under a protected directory owned by the selected
user, mode 0700, socket mode 0600. Reuse `endpoint::bind` no-follow ancestry,
ACL, stale-socket and same-inode cleanup checks. A non-socket or live listener
blocks startup. No network listener or unauthenticated request-file fallback is
part of this contract. An SSH client connects locally as the same user.

One newline-delimited UTF-8 JSON request and response per connection; maximum
request 64 KiB including newline, maximum response 1 MiB. Reject invalid UTF-8,
multiple/trailing requests and oversized frames. Use an absolute five-second
frame-read deadline and at most 32 admitted connections; overflow closes without
queuing unbounded work. Per-operation concurrency and execution deadlines are
separate server-side limits. No ancillary descriptors are accepted by the initial
operation protocol.

Capture the kernel `LOCAL_PEERTOKEN` audit token at accept, including PID,
incarnation and real/effective UIDs; require both UIDs to equal the configured
host user. Record the peer executable path as a kernel-observed diagnostic,
with an explicit unavailable reason if lookup fails; never substitute a
request-supplied PID/path/token. Audit token acquisition failure refuses admission.
A path lookup is not an immutable signature identity. A connected peer can
exec, exit or delegate its socket; the log describes the captured connection
peer, not an authenticated human or per-message sender.

Any same-UID process may call an enabled operation. `callerLabel` is asserted,
not authenticated and never an authorization credential. Socket permissions are
reachability, not per-tool isolation. The safety boundary is narrow operation
policy, not a bearer token readable by the same user or an interpreter allowlist.
Optional per-operation caller predicates may later use the captured token and
shared compiled-requirement checks without changing client request schemas.
Such restrictions must retain freshness/liveness limits honestly; they do not
turn asserted labels into authenticated seats.

## Per-operation policy and audit

| Policy field                        | Meaning                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`                           | Explicit consumer enablement; absent means unavailable                                                    |
| `sources` / `targets`               | Consumer-selected symbolic IDs mapped to fixed roots or app targets, never caller-selected absolute paths |
| `maxItems`, `maxBytes`              | Positive finite result/work limits checked during work, not just before it                                |
| `timeoutMs`, `concurrency`          | Positive finite server-owned deadline and active-work cap; excess returns `busy`                          |
| `requiredGrants`, `requiredSession` | Operation-specific prerequisites with honest denied/unknown states                                        |
| `callerPolicy`                      | Same-user default; optional tighter predicate, never asserted-label authentication                        |
| `commit`, `cancel`, `replay`        | Operation-specific publication point, disconnect behavior and retry rules                                 |

All operations are reviewed as running with **whole-disk read authority** because
the host holds Full Disk Access. The source allowlist is application policy, not
a macOS sandbox. Reject traversal, symlink/root escapes and caller-controlled
paths; check opened file identities rather than trusting string-prefix checks.
Do not expose environment overrides, arbitrary exec or arbitrary script bodies.
Time/size bounds must be enforced throughout work. Disconnect/deadline stops
uncommitted work; a documented atomic commit may finish while retaining lifecycle
exclusion. Never release exclusion while protected work still runs.

The host owns an append-only JSONL audit under private consumer-owned state,
files mode 0600. Assign a host-generated `auditId`; record UTC time, host release
and policy revisions, operation/version, request correlation, captured peer audit
token/PID/incarnation/UIDs/executable-path observation, asserted caller label
marked unauthenticated, policy decision, symbolic source/target IDs, bounded
counts/digests, duration and terminal result/error. Record denials too; malformed
or incomplete connections use null correlation. Never log file contents,
notification bodies, secrets or arbitrary raw request text. Consumer retention
and size limits are explicit; audit storage exhaustion refuses new work with
`audit-unavailable`, not unaudited execution. Persist admission before protected
work and outcome before reporting success. A crash may leave admitted work with
unknown outcome; recovery records that uncertainty, never fabricated success.
Same-UID audit storage is operational evidence, not tamper-proof forensics.

## Initial operations

### Allowlisted Documents copy

```typescript
type CopyInput = { sourceId: string; files: string[] }
type CopyResult = {
  auditId: string
  stagingId: string
  files: { name: string; bytes: number; sha256: string }[]
}
```

This is the first protected operation. The consumer maps each source ID to a
fixed Documents directory and sentinel; callers supply only distinct basenames
(1..255 UTF-8 bytes, no slash, NUL, `.` or `..`), never arbitrary paths. Limit
file count, total bytes and duration by consumer policy. Descriptor-relative
no-follow opens require regular files under the selected root; source changes,
symlinks, nonregular files and bound overruns refuse publication. Copy in the
host itself into a private per-request staging directory, compute hashes and
publish only a complete staged result atomically. Cleanup incomplete staging;
never return a partial success. Staging IDs are opaque host-generated names,
not caller paths. Do not overwrite an existing staged result on replay.

The existing narrow copy helper is source material for the later port, not a new
separately consented app to deploy. Preserve its allowlist, peer capture, bounded
copy, sentinel observations, hash receipts and audit semantics. A successful
sentinel/probe is evidence about that read, not a global TCC authorization oracle.
The consumer owns staging-to-inbox handoff and cleanup after import. Acceptance
requires a representative Documents copy with correlated audit/hashes **and one
successful backup import**; staging alone does not establish end-to-end readiness.

### Notifications

```typescript
type NotifyInput = { productId: string; title: string; body: string }
type NotifyResult = { auditId: string; notificationId: string; submitted: true }
```

`productId` selects a consumer-configured display label, not a bundle identity.
Bound title to 256 and body to 4096 UTF-8 bytes, with consumer rate/concurrency
limits. The host posts via its own notification APIs after Notifications consent;
the banner uses the host's name/icon and prefixes the title with the product
label. No arbitrary click command, URL, script or executable is accepted.
`submitted` means the OS accepted submission, not that a banner was displayed or
read. Audit metadata excludes title/body. New tools use this operation rather
than creating notification identities. An already separately allowed notifier
may retain its identity temporarily; further unification while preserving each
app's UI and behavior is a later migration, not a prerequisite for the host.

## Grants and human consent

| Grant              | Scope and procedure                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Full Disk Access   | Host identity; guided human System Settings approval, including for initial Documents copy |
| Screen Recording   | Host operation requiring capture; separate consent and positive experiment (DQ2)           |
| Accessibility      | Host AX operation; separate approval and positive experiment (DQ3)                         |
| Audio / microphone | Each platform-required audio category; separate approval and positive experiment (DQ4)     |
| Notifications      | Host allowance; verify actual sender and submission (DQ5)                                  |
| Automation         | Separate consent per target app; bounded target policy and experiment (DQ6)                |

One host means one stable identity, **not one universal consent click**. Each
permission type still needs approval; Automation needs approval per target.
There is no unmanaged pre-grant mechanism. The host holds FDA and every other
grant its enabled operations need, with usage descriptions/entitlements assembled
before sealing. Do not request unrelated grants merely because the host can.

Onboarding: install and verify the pinned sealed host; explain enabled operations
and their authority; with the human present perform the category-specific setup
and harmless positive operation; record outcomes and remaining unknowns. Runtime
requests never trigger unattended setup loops. Denial, revocation, missing GUI or
new targets return explicit action-required errors. Never reset TCC, edit its
database, impersonate another identity or fall back to another app's grant.
Ordinary client updates need no re-consent; host upgrades must preserve pinned
identity and pass DQ1 before claiming grant continuity.

## Stable signed releases and existing machinery

```text
consumer unsigned complete bundle + independently pinned policy
  -> describe-host -> desired descriptor
  -> seal-host -> immutable signed release
  -> install-host (keyless verification) -> direct launchd entrypoint
```

Reuse `effectUtils.lib.mkMacosApp` in
[`nix/macos-app/default.nix`](../../nix/macos-app/default.nix) and its complete
`hostBundle` input for the assembled native host. Existing outputs are `hostApp`,
`generation`, `requirement`, `hostSourceHash`, `desiredDescriptor`, `ctl`,
`ctlConfig` and `primitives`. `host` and `hostBundle` are mutually exclusive.
The current convenience host's generation maps actions to hashed external
payloads with enum/string/integer arguments and UID allowlists; it is **not** the
native typed registry above and must not become the host's privileged execution
interface. Its existing ctl/status protocol remains implementation evidence only.
Adding a generic operation requires a new assembled host release; policy changes
require reviewed immutable consumer configuration, never caller-supplied policy.

Pin the actual designated requirement, not its printed text. For a new identity
the builder defaults to identifier + Apple generic anchor + leaf Team ID;
incumbents retain their explicit predicates. CN, OU and leaf-certificate predicates
are not interchangeable. Security.framework compiles and checks predicates
against actual code. Matching bundle IDs or canonical requirement text does not
prove grant continuity, logical predicate equivalence or certificate-rotation
safety. Preserve a stable path and launch topology too.

Complete bundle policy declares outer entitlements/options and each nested code
object's relative path, identifier, requirement, entitlements and options. Reject
escaping/duplicate inventories, undeclared code and writable layouts; sign
nested code deepest-first, then the outer bundle, never infer with `--deep`.
`describe-host` is deterministic and unsigned. The `macos-app-unsigned` v1
descriptor binds ordered policy and a normalized full file inventory into
`hostRevision`. Normalization removes signature envelopes/resources, not ordinary
sealed resources. `hostSourceHash` alone does not cover a complete bundle.

`seal-host --desired APP --output RELEASE --keychain K
--keychain-password-fd N` is sign-only: dedicated non-login keychain, no password
in argv/environment/store, no prompts or ad-hoc fallback. Retain the existing
non-extractable-key, exact ACL/partition, trust-chain, bounded codesign and checked
relock rules in `macos-app-ctl`. Sealing checks staged content before signing and
publishes exactly `host.app`, `descriptor.json`, `receipt.json`. An existing
matching valid release is reused; mismatching output is refused. The
`macos-app-release` v1 receipt inventories sealed bytes, with `sealedRevision`
separate from source/unsigned revisions. A receipt is integrity evidence, not an
authority to choose the desired identity.

`install-host --desired DESCRIPTOR --artifact RELEASE --app-dir D --state S
--archive-dir R` verifies consumer-pinned desired policy, receipt, content and
actual signatures without signing credentials or fallback. Keep immutable
verified incumbents for rollback; invalid input leaves the incumbent unchanged.
Existing explicitly selected `--incumbent legacy` only relaxes unrecorded
incumbent layout compatibility, never strict outer signature, bundle ID or pinned
identity checks. Recorded incumbent configurations govern their own validation;
an invalid record cannot be bypassed with the legacy flag. This facility is not
a grant-transfer mechanism between product and host identities.

Consumer activation owns serialization, generation selection/GC roots,
installation, supplied-plist convergence, verification and rollback. Preserve
`--lifecycle-fd` exclusion and the consumer's pre-check interval; shared operation
admission retains exclusion until work finishes. ctl's acquiring `flock` check
is not proof the preceding interval was locked. Sign-only sealing is separate.
Use the existing journaled atomic-exchange installation/rollback behavior rather
than implementing a second installer. A no-op does not restart the host.
Supplied launchd plists must name the direct installed native entrypoint and
explicit domain/UID; scheduled idle evidence is distinct from a running process.
Status separates desired/installed/running release, policy and session state;
a launchctl PID alone is not authenticated running-code evidence.

Implementation sources: [`macos-app-ctl.rs`](../../nix/macos-app/host/src/bin/macos-app-ctl.rs),
[`wire.schema.json`](../../nix/macos-app/wire.schema.json), and the shared native
security modules in [`host/src`](../../nix/macos-app/host/src). None of these
mechanisms establishes historical TCC continuity without positive platform tests.

## Migration contract

```text
pause new product identities -> rewrite contract -> human-present experiments
  -> single host + Documents copy + successful import
  -> migrate each other operation -> retire superseded helper identities
```

Until the host provides the replacement operation, only grant-neutral changes
(add no consent identity and require no new approval) land. Per-product identity
rollouts remain paused; existing working helpers need not stop. This is a
transition rule, not permanent approval of independent permission identities.

For each tool, inventory its protected operation, required session/grants and
lifetime; move only the protected work into a reviewed host operation; migrate
all clients to typed IPC; obtain positive operation evidence and product-level
acceptance; disable the obsolete service and retire its separate consent
identity. Preserve product UI/business behavior outside the host. Never claim
that a helper's old grant automatically transfers to the host. Restic and
Watchman move under the host later and their identities retire; pinned-worker
and root-daemon feasibility are explicit gates, not reasons to expose exec or
silently keep permanent exception identities. The temporary already-allowed
notifier exception is described above.

## Evidence limits and open design questions

Experiment [0001](./.experiments/0001-tcc-attribution/README.md) T7/T9 establishes
that the launchd-started host is evaluated for socket/SSH-origin FDA-denied
reads. T5 establishes the same evaluated subject for a non-disclaimed child in
that denial fixture, **not positive access or universal grant inheritance**.
The other experiments are bounded fixtures: panel content, sealed-bundle
boundaries, audit-token checks and lifecycle/descriptor behavior. Their recorded
passes, blocked runs and skipped launchd cases retain their original scope.

- **DQ1 Host upgrade continuity:** Which release/DR changes preserve established
  grants? Resolve by a human-present positive upgrade and rollback experiment.
- **DQ2 Screen Recording:** Does the actual host-native capture operation retain
  host attribution and succeed for ungranted clients? Human-present experiment.
- **DQ3 Accessibility:** Does the actual host-native AX operation succeed and stay
  attributed to the host? Human-present experiment.
- **DQ4 Audio:** Which audio categories/session rules apply, and does each native
  operation succeed under the host identity? Human-present experiment.
- **DQ5 Notifications:** Does the host post with the intended sender/title and
  report denial accurately? Human-present experiment.
- **DQ6 Automation:** Does each allowlisted target use the host's target-specific
  consent, including new-target denial? Human-present experiment.
- **DQ7 Watchman integration:** Can the existing root-daemon topology/lifetime fit
  one consent-bearing host without root exec or another identity? Human-present
  experiment; no successful fit is claimed.
- **DQ8 Pinned restic worker:** Does a specifically pinned worker successfully
  perform FDA reads under the host, including changed worker bytes? Human-present
  positive experiment; denial attribution alone is insufficient.
- **DQ9 First Documents import:** Does bounded host-native copying reach one
  successful backup import with correlated audit/hash evidence? Human-present
  protected-read experiment plus consumer import receipt.

See [open-questions.md](./open-questions.md) for blockers and acceptance evidence.
