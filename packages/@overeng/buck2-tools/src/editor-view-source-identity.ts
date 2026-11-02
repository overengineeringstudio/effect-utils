import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

import { realpathThroughName } from './real-path.ts'

type SourceRoots = {
  readonly editorInputs: string
  readonly nodeModules: string
  readonly backingRoots?: readonly string[]
}

/** Metadata guards a content proof's lifetime; it never keys generation reuse. */
export const editorViewSourceIdentity = (options: SourceRoots): string => {
  const hash = createHash('sha256')
  const visited = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path) === true) return
    visited.add(path)
    const status = lstatSync(path, { bigint: true })
    hash.update(
      JSON.stringify(
        [
          path,
          status.dev,
          status.ino,
          status.mode,
          status.size,
          status.mtimeNs,
          status.ctimeNs,
        ].map(String),
      ),
    )
    if (status.isSymbolicLink() === true) {
      const target = realpathThroughName(path)
      hash.update(JSON.stringify([readlinkSync(path), target]))
      visit(target)
    } else if (status.isDirectory() === true)
      for (const name of readdirSync(path).toSorted()) visit(join(path, name))
  }
  for (const source of new Set([
    options.editorInputs,
    options.nodeModules,
    ...(options.backingRoots ?? []),
  ]))
    visit(realpathThroughName(source))
  return hash.digest('hex')
}

/** The same fail-closed comparison used after acquiring the publication fence. */
export const editorViewSourceIdentityMatches = ({
  options,
  identity,
}: {
  readonly options: SourceRoots
  readonly identity: string
}): boolean => editorViewSourceIdentity(options) === identity
