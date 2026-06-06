import { dirname, join, relative, resolve } from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { NmdCliError, NmdFileSystemError, type NmdError } from './errors.ts'

/** Regenerable path↔id index for a synced tree (NOT the source of identity). */
export const TreeIndex = Schema.Struct({
  version: Schema.Literal(1),
  root_page_id: Schema.String,
  /** Root-file basename, so a later run reconstructs the same layout. */
  root_file: Schema.String,
  /** posix relativePath (from root) → page_id; derived from frontmatter each run. */
  pages: Schema.Record({ key: Schema.String, value: Schema.String }),
}).annotations({ identifier: 'NotionMd.TreeIndex' })

export type TreeIndex = typeof TreeIndex.Type

const encodeTreeIndexJson = Schema.encodeSync(Schema.parseJson(TreeIndex, { space: 2 }))
const decodeTreeIndexJson = Schema.decodeUnknown(Schema.parseJson(TreeIndex), {
  errors: 'all',
  onExcessProperty: 'error',
} as const)

const toPosix = (value: string): string => value.split('\\').join('/')

const makeFsError = (opts: {
  readonly operation: string
  readonly path: string
  readonly cause: unknown
}): NmdFileSystemError =>
  new NmdFileSystemError({
    operation: opts.operation,
    path: opts.path,
    cause: opts.cause,
    message: `notion-md tree ${opts.operation} failed for ${opts.path}`,
  })

/** Absolute path to the internal directory-tree index for a tree root. */
export const treeIndexPath = (root: string): string => join(root, '.notion-md', 'workspace.json')

/** Read the internal tree index when present. */
export const readTreeIndexOptional = (
  root: string,
): Effect.Effect<TreeIndex | undefined, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = treeIndexPath(root)
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'exists', path, cause })))
    if (exists === false) return undefined
    const content = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'read', path, cause })))
    return yield* decodeTreeIndexJson(content).pipe(
      Effect.mapError(
        (cause) =>
          new NmdCliError({
            message: `Invalid tree index ${path}: ${String(cause)}`,
          }),
      ),
    )
  })

/** Write the derived tree index under the tree root's `.notion-md` directory. */
export const writeTreeIndex = (opts: {
  readonly root: string
  readonly index: TreeIndex
}): Effect.Effect<void, NmdFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = treeIndexPath(opts.root)
    yield* fs
      .makeDirectory(dirname(path), { recursive: true })
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'mkdir', path, cause })))
    yield* fs
      .writeFileString(path, `${encodeTreeIndexJson(opts.index).trimEnd()}\n`)
      .pipe(Effect.mapError((cause) => makeFsError({ operation: 'write', path, cause })))
  })

/** A file path matched against an ancestor notion-md tree index. */
export interface TreeMembership {
  readonly root: string
  readonly relPath: string
  readonly pageId: string
  readonly isRoot: boolean
  readonly index: TreeIndex
}

/**
 * Finds whether a local `.nmd` path is managed by an ancestor tree index.
 * Identity still lives in the file; this only routes callers to the right engine.
 */
export const findTreeMembership = (
  path: string,
): Effect.Effect<TreeMembership | undefined, NmdError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const absolute = resolve(path)
    let current = dirname(absolute)
    while (true) {
      const index = yield* readTreeIndexOptional(current)
      if (index !== undefined) {
        const relPath = toPosix(relative(current, absolute))
        const isRoot = relPath === index.root_file
        const pageId = isRoot === true ? index.root_page_id : index.pages[relPath]
        if (pageId !== undefined) {
          return { root: current, relPath, pageId, isRoot, index }
        }
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  })
