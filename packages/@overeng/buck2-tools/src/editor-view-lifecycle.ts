import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Editor roots discovered by the publisher and retired-worktree preflight. */
export const editorViewRootSuffixes = [
  '.editor-view',
  'packages/.editor-view',
  'context/.editor-view',
] as const

/** Persistent control identities retained by explicit editor-root release. */
export const isEditorViewReleaseControl = (name: string): boolean =>
  name === '.leases' || name === '.publish.lock'

/**
 * Fail closed on symlinked roots and publication locks. A released root contains
 * only persistent lease controls; payloads, pointers and retention records belong
 * to the editor lifecycle and must never be removed by a generic worktree tool.
 */
export const unreleasedEditorViewRoots = async (repoRoot: string): Promise<readonly string[]> => {
  const roots = await Promise.all(
    editorViewRootSuffixes.map(async (suffix) => {
      const root = join(repoRoot, suffix)
      const status = await lstat(root).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return undefined
        throw cause
      })
      if (status === undefined) return undefined
      if (status.isDirectory() === false) return root
      const entries = await readdir(root)
      return entries.some(
        (name) => name === '.publish.lock' || isEditorViewReleaseControl(name) === false,
      ) === true
        ? root
        : undefined
    }),
  )
  return roots.filter((root) => root !== undefined)
}
