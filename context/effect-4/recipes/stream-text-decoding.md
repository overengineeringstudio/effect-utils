# Pattern: stream-text-decoding

**Area:** Stream byte decoding **Kind:** call-shape change **Our usage:** git/process stdout and
stderr decoding in `megarepo`, `utils`, `utils-dev`, and `effect-ai-claude-cli`.

## v3

```ts
bytes.pipe(Stream.decodeText('utf-8'))
```

## v4

```ts
bytes.pipe(Stream.decodeText({ encoding: 'utf-8' }))
```

The encoding moved from a positional string to an options object. The no-options UTF-8 forms remain:

```ts
bytes.pipe(Stream.decodeText)
bytes.pipe(Stream.decodeText())
```

## Equivalence

The beta.102 signature and TextDecoder implementation are **VERIFIED** against the real tarball. A
cross-major probe split the four-byte UTF-8 encoding of `😀` across two `Uint8Array` chunks. Both
majors emitted exactly:

```json
["A", "😀B"]
```

This proves the replacement retains streaming decoder state across chunk boundaries for the tested
UTF-8 input. Owning process/CLI slices must compare complete stdout and stderr bytes separately,
including malformed-sequence handling where relevant.

## Intended differences

None.

## Gotchas

- Do not drop a non-default encoding while fixing the call shape.
- Constructing a new `TextDecoder` independently for every chunk corrupts multi-byte sequences
  split across chunks. Keep the Stream decoder.
- Text chunk boundaries are not a stable external contract; compare concatenated bytes/text unless
  the application explicitly consumes chunking.

## Codemod rule

`Stream.decodeText(encoding)` becomes `Stream.decodeText({ encoding })`. Calls that pass the stream
as the first argument become `Stream.decodeText(stream, { encoding })`.
