# Pattern: child-process-backpressure

**Area:** Platform / child process **Kind:** semantic **Our usage:** `pty-effect` and `megarepo`
consume long-running child stdout/stderr streams and must not lose, reorder, or deadlock output.

## v3

```ts
const executor = yield * CommandExecutor.CommandExecutor
const child = yield * executor.start(Command.make('bun', 'producer.ts', ...args))
```

## v4

```ts
const child = yield * ChildProcess.make('bun', ['producer.ts', ...args])
```

Both sides consume stdout, stderr, and exit status concurrently inside the child scope.

## Equivalence

```sh
bun run run child-process-backpressure
```

Result: **IDENTICAL**. Five repetitions of the invariant trace on each side produced the same
SHA-256, `c00e83de3a514a69999f05f4a54e7446eeaf7c15591c50c4a108f8d94e9b5e51`.

The large alternating case crosses pipe buffers with 3,145,728 bytes on each stream:

- stdout SHA-256 `e6c8ce3c4a4a41f01e5ed73ef32824c5f3bdb592a260feff59e0706ae9cba03d`
- stderr SHA-256 `b4e692ad7957e2375594c3baaf91a6f437d2a9e5cc93d697b0f62c30f64bd657`

The slow-consumer case delays every pull by 3 ms and still completes with 8,388,608 stdout bytes,
exit 0, and SHA-256
`558e18543f7631f2b35f841b318c578e1aa5d1c37a6ce676f153b4e0232f682c`.
The order-sensitive whole-stream hashes prove no per-stream loss or reordering.

## Non-deterministic raw boundary

The initial characterization retained each OS chunk boundary and the observed cross-stream
consumer order. Five identical runs produced five unique v3 trace hashes and five unique v4 trace
hashes. Chunk sizes, per-chunk hashes, and stdout/stderr scheduling vary within one major.

Chunk boundaries and exact cross-stream interleaving are therefore **NOT GATED**. Stable invariants
are gated instead: whole-stream bytes/hash, per-stream producer order, both-stream observation,
cross-stream progress, multiple chunks, exit status, and lossless slow-consumer completion. This
follows the harness README's I/O invariant rule.

## Intended differences (alignment register entries)

None. The invariant contract is identical.

## Gotchas

- Always consume stdout and stderr concurrently with exit status. Sequential collection can
  deadlock once either OS pipe fills.
- A small-output test does not exercise backpressure. The slow case emits 8 MiB and intentionally
  delays consumption.
- Do not snapshot OS chunk sizes or cross-stream scheduling; both are non-deterministic and are not
  application-level contracts.
- Keep stdout and stderr whole-stream hashes separate. Concatenating or merging them would erase
  stream identity and make scheduling look like data reordering.

## Codemod rule

No broad codemod beyond constructor syntax. Preserve scoped lifetime and concurrent consumption,
then replay the owning package's large-output invariant baseline.
