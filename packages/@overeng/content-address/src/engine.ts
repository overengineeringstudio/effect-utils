import { join, relative, resolve } from 'node:path'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Context, Effect, FileSystem, Layer, Schema, Sink, Stream } from 'effect'

import { Interop } from '@overeng/effect-rust'

import {
  canonicalJsonBytes,
  canonicalJsonCodec,
  canonicalJsonMediaType,
  descriptorForBytes,
  type descriptorForCanonicalJson,
  type descriptorForUtf8,
  hashBytes,
  type hashCanonicalJson,
  type hashUtf8,
  utf8Bytes,
  utf8TextMediaType,
} from './bytes.ts'
import { ContentDescriptor, ContentDigest, ContentStoreIoError } from './schema.ts'

/** Filesystem records framed by the action-runner tree digest protocol. */
export type TreeEntry =
  | { readonly kind: 'directory'; readonly path: string; readonly mode: number }
  | {
      readonly kind: 'symlink'
      readonly path: string
      readonly mode: number
      readonly target: string
    }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly mode: number
      readonly readPath: string
    }

/** Structural interface accepted directly by the generated ContentAddressCore Service. */
export interface RustByteEngine<TError> {
  readonly hash: (bytes: Uint8Array) => Effect.Effect<string, TError>
  readonly hasher: () => Sink.Sink<string, Uint8Array, never, TError>
  readonly hashTree: (
    source: Interop.HostCapability<readonly [string], Uint8Array>,
    records: readonly TreeEntry[],
  ) => Effect.Effect<string, TError>
}

/** Preorder, JS UTF-16 sibling order, lstat modes and literal symlink targets. */
export const treeEntries = Effect.fn('ContentAddress.treeEntries')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const absolute = resolve(root)
  const records: TreeEntry[] = []
  const visit = (path: string): Effect.Effect<void, ContentStoreIoError> =>
    Effect.gen(function* () {
      const info = yield* fs.stat(path).pipe(Effect.mapError(ioError(root)))
      const entryPath = relative(absolute, path) || '.'
      const mode = info.mode & 0o7777
      if (info.type === 'Directory') {
        records.push({ kind: 'directory', path: entryPath, mode })
        const names = yield* fs.readDirectory(path).pipe(Effect.mapError(ioError(root)))
        for (const name of names.toSorted()) yield* visit(join(path, name))
      } else if (info.type === 'SymbolicLink') {
        const target = yield* fs.readLink(path).pipe(Effect.mapError(ioError(root)))
        records.push({ kind: 'symlink', path: entryPath, mode, target })
      } else if (info.type === 'File')
        records.push({ kind: 'file', path: entryPath, mode, readPath: path })
      else return yield* ioError(root)(`Unsupported filesystem entry ${path}: ${info.type}`)
    })
  yield* visit(absolute)
  return records
})

/** Acquired byte engine with synchronous hashes and Effect-owned descriptor validation. */
export interface ContentAddressEngineApi {
  readonly hashBytes: typeof hashBytes
  readonly hashUtf8: typeof hashUtf8
  readonly hashCanonicalJson: typeof hashCanonicalJson
  readonly descriptorForBytes: typeof descriptorForBytes
  readonly descriptorForUtf8: typeof descriptorForUtf8
  readonly descriptorForCanonicalJson: typeof descriptorForCanonicalJson
  readonly hasher: () => Sink.Sink<ContentDigest, Uint8Array, never, ContentStoreIoError>
  readonly hashTree: (
    root: string,
  ) => Effect.Effect<ContentDigest, ContentStoreIoError, FileSystem.FileSystem>
}

/** Choose JS, wasm or native without changing the synchronous descriptor API.
 * Pure top-level helpers remain JS; Effect store operations honor this optional service.
 */
export class ContentAddressEngine extends Context.Service<
  ContentAddressEngine,
  ContentAddressEngineApi
>()('ContentAddress.Engine') {
  /** JavaScript implementation; also the default when no engine is provided. */
  static readonly layerJs = Layer.sync(this, () => makeJs())

  /** Pass the generated ContentAddressCore class; provide its wasm/native static Layer. */
  static layerRust<TError, TServices>(
    coreService: Effect.Effect<RustByteEngine<TError>, never, TServices>,
  ): Layer.Layer<ContentAddressEngine, never, TServices> {
    return Layer.effect(this, Effect.map(coreService, makeRust))
  }
}
const decodeDigest = Schema.decodeUnknownSync(ContentDigest)
const decodeDescriptor = Schema.decodeUnknownSync(ContentDescriptor)
const ioError = (root: string) => (cause: unknown) =>
  new ContentStoreIoError({
    operation: 'hashTree',
    path: root,
    message: `Unable to hash filesystem tree: ${root}`,
    cause,
  })

const jsHashTree = Effect.fn('ContentAddress.hashTree.js')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const records = yield* treeEntries(root)
  const hash = sha256.create()
  const length = new Uint8Array(4)
  const view = new DataView(length.buffer)
  const frame = (text: string) => {
    const bytes = utf8Bytes(text)
    view.setUint32(0, bytes.length, false)
    hash.update(length).update(bytes)
  }
  for (const record of records) {
    frame(record.path)
    frame(String(record.mode))
    frame(record.kind)
    if (record.kind === 'symlink') frame(record.target)
    else if (record.kind === 'file') {
      yield* fs.stream(record.readPath).pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => {
            hash.update(bytes)
          }),
        ),
        Effect.mapError(ioError(root)),
      )
    }
  }
  return decodeDigest(`sha256:${bytesToHex(hash.digest())}`)
})

const makeApi = ({
  hash,
  describe,
}: {
  readonly hash: typeof hashBytes
  readonly describe: typeof descriptorForBytes
}) => ({
  hashBytes: hash,
  hashUtf8: (value: string) => hash(utf8Bytes(value)),
  hashCanonicalJson: ((options) =>
    hash(canonicalJsonBytes(options))) satisfies typeof hashCanonicalJson,
  descriptorForBytes: describe,
  descriptorForUtf8: (({ value, mediaType = utf8TextMediaType, ...metadata }) =>
    describe({
      bytes: utf8Bytes(value),
      mediaType,
      ...metadata,
    })) satisfies typeof descriptorForUtf8,
  descriptorForCanonicalJson: (({ schema, value, schemaVersion }) =>
    describe({
      bytes: canonicalJsonBytes({ schema, value }),
      mediaType: canonicalJsonMediaType,
      codec: canonicalJsonCodec,
      schemaVersion,
    })) satisfies typeof descriptorForCanonicalJson,
})
const makeJs = () => ({
  ...makeApi({ hash: hashBytes, describe: descriptorForBytes }),
  hasher: () =>
    Sink.suspend(() => {
      const state = sha256.create()
      return Sink.forEach((bytes: Uint8Array) =>
        Effect.sync(() => {
          state.update(bytes)
        }),
      ).pipe(Sink.map(() => decodeDigest(`sha256:${bytesToHex(state.digest())}`)))
    }),
  hashTree: jsHashTree,
})

// Build the acquired API outside the layer's Effect callback. The returned
// synchronous methods run only when called, not while acquiring the service.
const makeRust = <TError>(core: RustByteEngine<TError>): ContentAddressEngineApi => ({
  ...makeApi({
    hash: (bytes) => decodeDigest(Effect.runSync(core.hash(bytes))),
    describe: ({ bytes, mediaType, codec, schemaVersion }) => {
      // The original Effect schema owns JS string and optional metadata semantics.
      return decodeDescriptor({
        _tag: 'ContentDescriptor',
        digest: decodeDigest(Effect.runSync(core.hash(bytes))),
        byteLength: bytes.byteLength,
        mediaType,
        ...(codec === undefined ? {} : { codec }),
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
      })
    },
  }),
  hasher: () =>
    core.hasher().pipe(
      Sink.map(decodeDigest),
      Sink.mapError(
        (cause) =>
          new ContentStoreIoError({
            operation: 'hasher',
            path: '',
            message: 'Unable to hash byte stream',
            cause,
          }),
      ),
    ),
  hashTree: Effect.fn('ContentAddress.hashTree.rust')(function* (root: string) {
    const fs = yield* FileSystem.FileSystem
    const records = yield* treeEntries(root)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Interop.hostCapability('abortable', (path: string) =>
          fs.readFile(path),
        )
        return yield* core
          .hashTree(source, records)
          .pipe(Effect.map(decodeDigest), Effect.mapError(ioError(root)))
      }),
    )
  }),
})
