# Sync Orchestration Spec

Sub-system slice of [spec.md](../../spec.md). Serves [requirements](./requirements.md).

Requirement trace: SYNC-R01, SYNC-R02, XC-R02, XC-R04.

This sub-system owns established reconciliation and the outbox executor: the
deterministic, lease-fenced components that capture local desired state, observe
remote state, plan base/local/remote decisions, and turn committed outbox
commands into verified remote writes. The outbox projection table itself is
defined by the sync-store sub-system; see
[../sync-store/spec.md](../sync-store/spec.md) for the `outbox` projection
contract.

## Established Reconciliation

Established commands (`sync`, `push`, and `sync --watch`) are local-capture-first
to satisfy XC-R04:

```text
capture local desired state
-> observe remote state
-> plan base/local/remote decisions
-> execute verified outbox commands
-> guarded materialization
-> refresh status
```

Local desired state includes public SQLite `rows`/`changes` intents and
NotionMD `.nmd` body observations, including path, page identity, captured local
content or recoverable content reference, and typed body identity for the known
base/local state.
Capturing local desired state must happen before any operation that can
overwrite user-authored local artifacts. Remote observation may refresh private
base/remote projections before planning, but it must not materialize remote
body content into `.nmd` paths or otherwise overwrite local artifacts until
guarded materialization runs after planning.

The normal workspace experience keeps the SQLite replica and Markdown page
bodies converged together. Users should not have to decide which surface to
sync: initial adoption and established `sync` materialize `.nmd` artifacts,
observe row properties, observe bodies, plan local changes, and settle remote
writes as one reconciliation loop. Selective or suppressed surfaces are
advanced escape hatches for tests, debugging, or explicit policy boundaries;
they are not the product default and must not change the normal convergence
contract.

When body observation is explicitly suppressed, the sync pass treats the body
surface as absent. It may still observe and reconcile row properties and
lifecycle state, but it must not invent placeholder body hashes or mutate the
existing body projection. A suppressed body lane preserves the last real body
fact until a later body-observing sync replaces it.

`sync --from-notion` is the initial adoption exception: it has no established
local desired state for that workspace and remains remote-to-local only. Once a
workspace is established, all sync modes use the local-capture-first invariant.

Guarded materialization may write a remote-observed artifact only when one of
these proofs holds:

| Local target state                                        | Materialization behavior                                    |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| target is unchanged from captured/base state              | materialize remote state                                    |
| target matches this process's own materialization token   | verify/update sidecars without creating a local edit intent |
| target contains uncaptured or changed local desired state | preserve it and plan push/conflict/repair; do not overwrite |
| target identity/path claim is ambiguous                   | fail closed with repair/path conflict; do not overwrite     |

The planner decides whether captured local desired state becomes an outbox
command, a conflict, an unsupported change, or a rejected malformed intent. The
materializer only reflects decisions that have already preserved local content
or proven it safe to overwrite.

Body conflicts are same-surface conflicts. A sync pass observes every remote
body, but it may open a body conflict only for a page whose captured local
`.nmd` desired state differs from its known base, whose body push fails
read-after-write verification, or whose body adapter reports a body-specific
guard for that page. Re-observing unchanged or newly materialized body artifacts
must not create unrelated body conflicts during property/lifecycle sync.

## Outbox Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Queued: CommandEnqueued
  Queued --> Running: lease token claimed
  Running --> Retryable: transient failure / rate limit
  Retryable --> Queued: retry due
  Running --> Ambiguous: attempted without settlement
  Ambiguous --> Queued: verify current remote first
  Ambiguous --> Settled: verified desired state
  Running --> Blocked: guard failed
  Queued --> Blocked: preflight guard failed
  Running --> Settled: verified success / verified no-op
  Running --> Fenced: lease token stale
  Fenced --> Queued: replan by current owner
  Blocked --> Queued: conflict resolved / repair event
  Settled --> [*]
```

Outbox commands are deterministic data:

```ts
type OutboxCommand = {
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly rootId: SyncRootId
  readonly intentEventId: EventId
  readonly surface: SurfaceKey
  readonly command:
    | PatchPagePropertiesCommand
    | PatchDataSourceSchemaCommand
    | TrashPageCommand
    | RestorePageCommand
    | BodyPushCommand
  readonly baseHash: Hash
  readonly desiredHash: Hash
  // Body commands carry typed body identities instead of generic base/desired
  // hash semantics. Property, schema, and lifecycle commands continue to use
  // canonical surface hashes.
  readonly preflight: readonly GuardName[]
}
```

## Executor Sequence

The executor sequence is:

1. claim a queued command with the current lease token,
2. read the current remote surface and schema,
3. run preflight guards against `baseHash`,
4. revalidate the local lease immediately before the remote write,
5. write remotely outside a SQLite transaction,
6. read the remote surface again,
7. append exactly one settlement event if the observed surface equals the desired
   surface; body commands compare typed body identity.

Steps 2-3 satisfy SYNC-R01: the executor re-reads the current remote surface and
schema and validates `baseHash` before any write that could conflict or destroy
data. Steps 6-7 satisfy SYNC-R02: a successful write is settled only after a
fresh read and canonical hash comparison prove the remote state equals
`desiredHash`.

For body pushes, the body adapter returns the verified post-write `BodyPointer`.
The executor settles only against that verified typed body identity, and the
store advances the body projection to the returned `BodyProjectionPayload`. If a
local `.nmd` file is present, the NotionMD-backed adapter also refreshes its
clean base/sidecar after confirming the file still matches the pushed desired
body, so the next sync observes a clean no-op instead of re-planning the same
body edit.

## Ambiguous Command Handling

If a command has an attempt record without a settlement record, restart marks it
ambiguous before any retry. Ambiguous commands must re-read the current remote
surface and schema first. They settle as `verified no-op` when the observed hash
already equals `desiredHash`, replan when the observed hash proves a disjoint
remote change, or open conflict when the outcome cannot be attributed safely.

If a remote write succeeds and the process crashes before settlement, retrying
the command must settle as `verified no-op` when read-after-write already shows
`desiredHash`. If two attempts race, the first verified settlement event is
terminal and later attempts append `fenced stale attempt` or are ignored by
idempotency.

## Lease Fencing

Lease fencing protects SQLite settlement, not Notion itself. A stale process
cannot settle a command with an old token; if it wrote remotely after losing the
lease, the current owner observes the changed remote hash and replans or opens a
conflict. The lease lifecycle and fencing tokens are owned by the
[watch-daemon sub-system](../watch-daemon/spec.md); the executor only consumes
the current token and refuses to settle under a stale one.
