# Pattern: shutdown-drain

**Area:** Runtime shutdown and interruption **Kind:** semantic **Our usage:** background pushers,
queues, and single-owner drains.

## v3

```ts
// Application-level close state plus an in-band sentinel:
closed = true
yield * Queue.offer(queue, End)
```

The sole consumer finishes the in-flight item and every item ahead of the sentinel. Producers
reject offers after `closed` becomes true.

## v4

```ts
const queue = yield * Queue.unbounded<Item, Cause.Done>()
yield * Queue.end(queue)
```

`Queue.end` stops new offers while retaining queued items for the sole consumer to drain.

## Equivalence

```sh
bun run run:pattern shutdown-drain
```

IDENTICAL. With item 1 held in flight, items 2 and 3 queued, and shutdown requested, both traces
finish `1, 2, 3` in order, reject item 4, and report maximum handler concurrency of one.

## Intended differences (alignment register entries)

- None in the observable drain contract. The v4 queue has a first-class end state, replacing the
  v3 application-level sentinel and close flag.

## Gotchas

- Do not interrupt the sole consumer in a scope finalizer and then start a second “drain” consumer.
  That loses ownership and can reorder or duplicate work.
- `Queue.shutdown` is destructive cancellation; `Queue.end` is graceful completion. Use the latter
  for a drain contract.
- The close/end transition must be uninterruptible with respect to ownership handoff. Failure of a
  queued operation must fail teardown rather than silently report successful shutdown.
- Keep deterministic barriers around “first item in flight” and “remaining items queued”; sleeps do
  not prove this boundary.

## Codemod rule

None. Replacing an application sentinel with `Queue.end` requires proving producer rejection,
consumer ownership, failure propagation, and ordering.
