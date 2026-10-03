# Spec: content-address

This document specifies reusable content-addressed descriptors, stores, resolver context, and artifact URIs for effect-utils systems.

## Status

Draft.

## Scope

**Defines:** descriptor shape, digest format, deterministic object paths, store behavior, resolver behavior, and `cas:` artifact URI semantics.

**Does not define:** product-specific artifact roles, viewer UIs, remote artifact hosting policy, or OpenTelemetry semantic conventions.

## VRS Hierarchy

`content-address` is a cross-cutting VRS root under `context/content-address`.

Subsystems:

- `01-descriptors` - digest, byte length, media type, codec, schema version, canonical JSON.
- `02-object-store` - deterministic object paths, atomic writes, deduplication.
- `03-resolvers` - URI parsing, root/transport context, verification, failure modes.
- `04-pins-and-roots` - explicit retention roots, refs, manifests, and garbage collection.
- `05-integrations` - product-specific usage such as `otel-scrape` profile links.

The first implementation package is `packages/@overeng/content-address`. The package may keep implementation docs locally, but durable system intent lives here.

See [.decisions/0001-context-vrs-root.md](./.decisions/0001-context-vrs-root.md).

## Descriptors

The descriptor contract is:

```ts
interface ContentDescriptor {
  readonly _tag: 'ContentDescriptor'
  readonly digest: `sha256:${string}`
  readonly byteLength: number
  readonly mediaType: string
  readonly codec?: string
  readonly schemaVersion?: number
}
```

`digest` is lowercase hex SHA-256 in `sha256:<64 hex>` form. `byteLength` is the exact encoded byte length. `mediaType` describes the encoded bytes, not an eventual rendered view.

Canonical JSON descriptors hash the canonical UTF-8 JSON bytes and stamp `codec: 'canonical-json'`.

Descriptor APIs are the base layer. They may be used independently when a caller only needs stable identity or verification.

### Byte engine selection

The synchronous descriptor/hash helper signatures remain unchanged. Pure top-level helpers use the JavaScript implementation. Effect store writes and verification honor an optional `ContentAddressEngine` service; absent a layer, they retain the existing JavaScript behavior.

`ContentAddressEngine.layerJs` selects JavaScript. For a generated `ContentAddressCore` service package built by `//rust/content-address-service:service`, select Rust with:

```ts
const engine = ContentAddressEngine.layerRust(ContentAddressCore).pipe(
  Layer.provide(ContentAddressCore.layerWasm.node()),
)
// Replace layerWasm.node() with layerNative.node() or the corresponding Bun static.
```

The public TypeScript package does not depend on a generated Rust product. Applications supply the generated service tag and its selected runtime layer; the parity harness stages that service beside the admitted TypeScript output at the Rust service boundary.

The service exposes the same synchronous hashing/descriptor functions, an incremental byte `Sink` (`hasher()`), and filesystem `hashTree(root)`. Canonical JSON and manifests remain Effect-owned. `hashTree` uses the existing action-runner protocol in `rust/buck2-tools/core/src/fingerprint.rs`: preorder, UTF-16 sibling ordering, root path `.`, permission bits `0o7777`, u32 big-endian UTF-8 text frames for path/mode/kind and symlink target, and unframed file bytes. This is distinct from the editor-view `effect-utils/tree-digest/v1` protocol.

`ContentDescriptor` in `src/schema.ts` is the contract authority. `src/generate-contract.ts` compiles that ordinary Effect Schema directly into `rust/content-address-contract`, preserving numeric safe-integer bounds, named string constraints and optional-key semantics. The compiler emits Rust validation and schemars metadata from one IR, using explicit Cargo workspace mode; there is no separately authored decimal projection or schema implementation. The Effect engine constructs public descriptors from the Rust-computed digest and validates metadata with the original Effect schema, preserving existing JavaScript-string semantics. Regenerate with `bun packages/@overeng/content-address/src/generate-contract.ts`, then run the ordinary Genie projections.

The Rust async tree export receives an abortable host Source for bounded byte reads; filesystem traversal and symlink discovery remain in Effect. It requests at most 256 KiB at an explicit offset, accepts short reads until an empty EOF response, and cooperatively yields after each chunk so the host can deliver cancellation. Shared deterministic vectors and real-tree/store/manifest checks run through `//rust/content-address-service:engine-parity-node` and `:engine-parity-bun`, using the actual typed generated service staged by the Buck parity rule. The runner exercises wasm/native products against JS, including public metadata semantics and mode/symlink identity, and records directional 1 KiB/1 MiB/100 MiB and tree benchmarks with runtime version and host load.

## Object Paths

Object paths are derived mechanically from the digest:

```text
sha256/<first-byte-hex>/<remaining-31-bytes-hex>
```

For example:

```text
sha256/ab/cdef...
```

The fan-out path is relative to a configured object-store root. It is not a URI by itself and must not be interpreted as an absolute path.

## Store Contract

A store writes and reads descriptor-addressed bytes. Store APIs compose descriptors and object paths rather than asking product systems to derive paths manually.

Blob presence is not retention intent. Stores may contain unpinned objects from failed writes, partial workflows, or expired runs. Pinning and garbage collection are separate layers.

Illustrative interface:

```ts
interface ContentStore {
  put(
    bytes: Uint8Array,
    metadata: DescriptorMetadata,
  ): Effect.Effect<ContentDescriptor, ContentAddressError>
  get(descriptor: ContentDescriptor): Effect.Effect<Uint8Array, ContentAddressError>
  has(descriptor: ContentDescriptor): Effect.Effect<boolean, ContentAddressError>
}
```

`put` derives the descriptor from bytes and writes them under the derived object path. `get` reads by descriptor and verifies before returning. Implementations must avoid publishing partially written files as complete objects.

## URI Contract

`cas:` URIs name objects by deterministic object path:

```text
cas:sha256/<first-byte-hex>/<remaining-31-bytes-hex>
```

The URI is location-independent. A resolver supplies the store root or transport context and maps the URI to bytes. The descriptor remains the authority for verification; the URI is the retrieval key.

The URI intentionally duplicates digest information already present in the descriptor. Resolvers must treat disagreement between the URI object path and the descriptor digest as a typed integrity failure.

See [.decisions/0004-full-digest-path-cas-uri.md](./.decisions/0004-full-digest-path-cas-uri.md).

## Resolver Contract

A resolver accepts:

- a `cas:` URI,
- an expected descriptor,
- an explicit resolver context such as a filesystem object-store root.

It returns verified bytes or a typed failure. Resolution must fail if:

- the URI scheme is unsupported,
- the digest algorithm is unsupported,
- the URI object path does not match the expected descriptor digest,
- the object is missing,
- the bytes do not match the descriptor digest or byte length,
- the path escapes the configured store root.

The implementation API is layered: descriptor utilities, object-path utilities, store operations, and resolver operations are distinct modules or exported groups. Product systems should prefer store/resolver APIs for artifact workflows and descriptor APIs for pure identity/verification workflows.

See [.decisions/0002-layered-cas-api.md](./.decisions/0002-layered-cas-api.md).

## Pins, Roots, And Garbage Collection

A pin is an explicit retention root for one descriptor or a manifest descriptor. Pins are not part of blob identity; they are mutable reachability metadata for lifecycle management.

The primary pin target is a manifest descriptor. A manifest is content-addressed bytes that list the descriptors retained as one logical bundle.

Illustrative manifest shape:

```ts
interface ContentManifest {
  readonly _tag: 'ContentManifest'
  readonly schemaVersion: 1
  readonly role: string
  readonly createdAt?: string
  readonly entries: ReadonlyArray<{
    readonly descriptor: ContentDescriptor
    readonly logicalPath?: string
    readonly role?: string
  }>
}
```

The CAS design follows the same separation used by established systems:

- content-addressed blobs are immutable by digest,
- roots, refs, action records, manifests, or pins provide lookup and reachability,
- garbage collection removes only objects unreachable from the configured roots.

The first implementation must support manifest pins before exposing destructive garbage collection.

Pin records are mutable store metadata. A filesystem store may represent pins as files under a pins directory whose contents name a manifest descriptor. The exact path format is implementation-specific, but pin records must not be confused with content-addressed object paths.

See [.decisions/0003-manifest-pins.md](./.decisions/0003-manifest-pins.md).

## Integration: otel-scrape

`otel-scrape` profile links use this system for artifact identity and retrieval. Spans carry descriptors and `cas:` URIs; the run context supplies the CAS root resolver.

`otel-scrape` may define profile types and viewer metadata, but it must not define a separate artifact identity scheme.

An `otel-scrape` run should write one content-addressed manifest for the run's retained profile artifacts and pin that manifest for the desired retention window. Individual spans still link to individual artifact `cas:` URIs.

## Open Design Questions

None.
