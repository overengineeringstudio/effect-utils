# Pattern: rpc-payload-codecs

**Area:** RPC boundary **Kind:** semantic **Our usage:** 11 `@effect/rpc` import sites plus
`effect-rpc-tanstack`.

## v3

```ts
const encoded = Schema.encodeSync(rpc.payloadSchema)(payload)
const decoded = Schema.decodeUnknownSync(rpc.payloadSchema)(encoded)
```

Effect 3 RPC clients encoded the declared payload schema directly.

## v4

```ts
const codec = Schema.toCodecJson(rpc.payloadSchema)
const encoded = Schema.encodeSync(codec)(payload)
const decoded = Schema.decodeUnknownSync(codec)(encoded)
```

Effect 4 RPC clients and servers explicitly use the JSON codec projection.

## Equivalence

```sh
bun run run:pattern rpc-payload-codecs
```

Payloads are IDENTICAL at beta.99 for exact JSON bytes and decoded handler values across
missing/present optional fields, `null`, `Option` none/some, unions, and both unary and streaming
payload schemas.

Two byte differences are ALLOWLISTED: unary and streaming tagged-failure envelopes change from the
v3 recursive Cause object to the v4 flat reasons array. Both decode back to the identical tagged
failure and message.

## Intended differences (alignment register entries)

- RPC failure Cause bytes change from `{"_tag":"Fail",...}` to
  `[{"_tag":"Fail",...}]`, the v4 flattened Cause representation. The library
  supports only its current format. Independently deployed consumers own the
  same-contract peer upgrade, explicit cache/open-tab rollout policy, and live
  verification at every HTTP RPC, SSR `Exit`, or persisted-envelope boundary;
  mixed-major decoding is unsupported.

## Gotchas

- A custom transport receives the encoded RPC message. Before calling a handler, decode
  `request.payload` with `Schema.decodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema))`.
- Encode unary exits, streaming chunks, streaming exits, and parse failures with their corresponding
  JSON-projected schemas. Payload-only coverage is incomplete.
- Compare `JSON.stringify(encoded)` or transport bytes, not only decoded values.
- `Rpc.fromTaggedRequest` was removed. Rebuild the RPC explicitly with `Rpc.make(tag, { payload,
success, error })`; do not cast the old tagged request class into the new API.
- Real clone/native-RPC transports need a separate real-runtime byte-boundary test; this in-process
  prototype cannot prove structured-clone compatibility.

## Codemod rule

None. The import path changes mechanically from `@effect/rpc` to `effect/unstable/rpc`, but
`Rpc.fromTaggedRequest` removal and custom dispatch decoding require schema-aware rewrites.
