import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Effect, Schema } from 'effect'

import { NmdStorageSchema, type NmdFrontmatterV1 } from '@overeng/notion-effect-client'

import { NmdSidecarError } from './errors.ts'

export const NmdSidecarV1 = Schema.Struct({
  version: Schema.Literal(1),
  page_id: Schema.String,
  reason: Schema.Literal('too_large', 'volatile_url'),
  storage: NmdStorageSchema,
}).annotations({ identifier: 'NotionMd.SidecarV1' })

export type NmdSidecarV1 = typeof NmdSidecarV1.Type

const strictOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const

const decodeSidecar = Schema.decodeUnknownSync(NmdSidecarV1, strictOptions)

const sameIds = (left: readonly string[], right: readonly string[]): boolean => {
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
      sameIds(
        storage.unsupported_block_ids,
        sidecarStorage.unsupported_blocks.map((block) => block.block_id),
      ) === false
    ) {
      throw new Error('Sidecar unsupported block ids do not match frontmatter')
    }

    if (
      sameIds(
        storage.file_ids,
        sidecarStorage.files.map((file) => file.id),
      ) === false
    ) {
      throw new Error('Sidecar file ids do not match frontmatter')
    }

    if (
      sameIds(
        storage.comment_ids,
        sidecarStorage.comments.map((comment) => comment.id),
      ) === false
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
