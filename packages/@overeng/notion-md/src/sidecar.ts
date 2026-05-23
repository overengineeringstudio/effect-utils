import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, Schema } from 'effect'

import { NmdStorageSchema, type NmdFrontmatterV1 } from '@overeng/notion-effect-client'

import { NmdSidecarError } from './errors.ts'
import { canonicalizeMarkdown, sha256Digest } from './hash.ts'

/** Strict schema for overflow `.nmd` storage sidecars. */
export const NmdSidecarV1 = Schema.Struct({
  version: Schema.Literal(1),
  page_id: Schema.String,
  reason: Schema.Literal('too_large', 'volatile_url'),
  storage: NmdStorageSchema,
}).annotations({ identifier: 'NotionMd.SidecarV1' })

export type NmdSidecarV1 = typeof NmdSidecarV1.Type

/** Strict schema for the last clean body snapshot used by guarded merges. */
export const NmdBaseSnapshotV1 = Schema.Struct({
  version: Schema.Literal(1),
  page_id: Schema.String,
  body_hash: Schema.String,
  body: Schema.String,
}).annotations({ identifier: 'NotionMd.BaseSnapshotV1' })

export type NmdBaseSnapshotV1 = typeof NmdBaseSnapshotV1.Type

const strictOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

const decodeSidecar = Schema.decodeUnknownSync(NmdSidecarV1, strictOptions)
const decodeBaseSnapshot = Schema.decodeUnknownSync(NmdBaseSnapshotV1, strictOptions)

/** Path for the last clean body snapshot next to a `.nmd` file. */
export const baseSnapshotPath = (path: string): string => `${path}.base.json`

const sameIds = (opts: {
  readonly left: readonly string[]
  readonly right: readonly string[]
}): boolean => {
  const { left, right } = opts
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((id) => rightSet.has(id))
}

const validateSidecarReferences = (opts: {
  readonly path: string
  readonly sidecarPath: string
  readonly frontmatter: NmdFrontmatterV1
  readonly sidecar: NmdSidecarV1
}): Effect.Effect<void, NmdSidecarError> =>
  Effect.sync(() => {
    const storage = opts.frontmatter.notion_md.storage
    if (storage._tag !== 'sidecar') return

    if (opts.sidecar.page_id !== opts.frontmatter.notion_md.page_id) {
      throw new Error(
        `Sidecar page id ${opts.sidecar.page_id} does not match ${opts.frontmatter.notion_md.page_id}`,
      )
    }

    const sidecarStorage = opts.sidecar.storage
    if (sidecarStorage._tag !== 'self_contained') {
      throw new Error('Sidecar payload must contain self-contained storage')
    }

    if (
      sameIds({
        left: storage.unsupported_block_ids,
        right: sidecarStorage.unsupported_blocks.map((block) => block.block_id),
      }) === false
    ) {
      throw new Error('Sidecar unsupported block ids do not match frontmatter')
    }

    if (
      sameIds({
        left: storage.file_ids,
        right: sidecarStorage.files.map((file) => file.id),
      }) === false
    ) {
      throw new Error('Sidecar file ids do not match frontmatter')
    }

    if (
      sameIds({
        left: storage.comment_ids,
        right: sidecarStorage.comments.map((comment) => comment.id),
      }) === false
    ) {
      throw new Error('Sidecar comment ids do not match frontmatter')
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new NmdSidecarError({
          path: opts.path,
          sidecar_path: opts.sidecarPath,
          cause,
          message: `Invalid .nmd sidecar ${opts.sidecarPath}`,
        }),
    ),
  )

/** Load and validate sidecar storage referenced by frontmatter, if present. */
export const validateReferencedSidecar = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV1
}): Effect.Effect<NmdSidecarV1 | undefined, NmdSidecarError> =>
  Effect.gen(function* () {
    const storage = opts.frontmatter.notion_md.storage
    if (storage._tag !== 'sidecar') return undefined

    const sidecarPath = join(dirname(opts.path), storage.path)
    const sidecar = yield* Effect.tryPromise({
      try: () => readFile(sidecarPath, 'utf8'),
      catch: (cause) =>
        new NmdSidecarError({
          path: opts.path,
          sidecar_path: sidecarPath,
          cause,
          message: `Failed to read .nmd sidecar ${sidecarPath}`,
        }),
    }).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => decodeSidecar(JSON.parse(content)),
          catch: (cause) =>
            new NmdSidecarError({
              path: opts.path,
              sidecar_path: sidecarPath,
              cause,
              message: `Failed to parse .nmd sidecar ${sidecarPath}`,
            }),
        }),
      ),
    )

    yield* validateSidecarReferences({
      path: opts.path,
      sidecarPath,
      frontmatter: opts.frontmatter,
      sidecar,
    })

    return sidecar
  })

/** Write the last clean body snapshot needed for three-way conflict evidence. */
export const writeBaseSnapshot = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV1
  readonly body: string
}): Effect.Effect<void, NmdSidecarError> =>
  Effect.tryPromise({
    try: () => {
      const body = canonicalizeMarkdown(opts.body)
      return writeFile(
        baseSnapshotPath(opts.path),
        `${JSON.stringify(
          {
            version: 1,
            page_id: opts.frontmatter.notion_md.page_id,
            body_hash: opts.frontmatter.notion_md.body.hash,
            body,
          },
          null,
          2,
        )}\n`,
      )
    },
    catch: (cause) =>
      new NmdSidecarError({
        path: opts.path,
        sidecar_path: baseSnapshotPath(opts.path),
        cause,
        message: `Failed to write .nmd base snapshot ${baseSnapshotPath(opts.path)}`,
      }),
  })

/** Load and validate the last clean body snapshot for conflict handling. */
export const readBaseSnapshot = (opts: {
  readonly path: string
  readonly frontmatter: NmdFrontmatterV1
}): Effect.Effect<NmdBaseSnapshotV1, NmdSidecarError> =>
  Effect.gen(function* () {
    const snapshotPath = baseSnapshotPath(opts.path)
    const snapshot = yield* Effect.tryPromise({
      try: () => readFile(snapshotPath, 'utf8'),
      catch: (cause) =>
        new NmdSidecarError({
          path: opts.path,
          sidecar_path: snapshotPath,
          cause,
          message: `Failed to read .nmd base snapshot ${snapshotPath}`,
        }),
    }).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => decodeBaseSnapshot(JSON.parse(content)),
          catch: (cause) =>
            new NmdSidecarError({
              path: opts.path,
              sidecar_path: snapshotPath,
              cause,
              message: `Failed to parse .nmd base snapshot ${snapshotPath}`,
            }),
        }),
      ),
    )

    if (
      snapshot.page_id !== opts.frontmatter.notion_md.page_id ||
      snapshot.body_hash !== opts.frontmatter.notion_md.body.hash ||
      sha256Digest(snapshot.body) !== snapshot.body_hash
    ) {
      return yield* new NmdSidecarError({
        path: opts.path,
        sidecar_path: snapshotPath,
        message: `Invalid .nmd base snapshot ${snapshotPath}`,
      })
    }

    return snapshot
  })
