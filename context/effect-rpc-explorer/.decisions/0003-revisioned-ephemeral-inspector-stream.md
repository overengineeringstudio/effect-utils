# 0003 - Use one bounded revisioned in-memory inspector stream

Status: accepted

## Context

Live inspection needs a coherent initial view and later changes without losing
a mutation between snapshot and subscription. Persistent storage or an external
collector would change an embedded diagnostic surface into an operational
system.

## Options

| Option                                    | Result   | Reason                                                                   |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------ |
| External collector or durable history     | Rejected | Violates the embedded ephemeral boundary and adds operational ownership. |
| Independently read snapshot and subscribe | Rejected | Has an unavoidable handoff race.                                         |
| One ordered in-memory revisioned stream   | Selected | Supplies a coherent prefix while enforcing one bounded model.            |

## Decision

Keep explorer state scoped in memory and serialize state mutation, revision,
replay, and watch registration through one boundary.

## Evidence and Argument

One ordered mutation boundary can choose a snapshot/replay prefix while
registering a subscriber, then publish later revisions after that prefix. This
eliminates the snapshot/subscription handoff race without persistence or an
external collector.

## Consequences

- Core state is scoped in-memory only; restart intentionally loses history.
- Inspector frames are typed NDJSON Snapshot, Delta, and Reset frames.
- A watch receives a contiguous replay or Reset plus Snapshot; slow consumers
  reset rather than silently drop a delta.
- Retention bounds are independent for records, values, deltas, and subscriber
  queues, and their loss evidence contains no discarded content.
- Inspector RPCs are excluded before mutation, preventing recursive watch
  traffic.
