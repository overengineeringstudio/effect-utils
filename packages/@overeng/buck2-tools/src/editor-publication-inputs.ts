import { realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

import {
  editorPublicationIsolation,
  editorPublicationOwnerFdEnv,
  requireEditorPublicationOwner,
} from './editor-publication-owner.ts'
import { realpathThroughName } from './real-path.ts'

const isMutableBuckPath = (path: string | undefined): path is string =>
  path !== undefined &&
  path.startsWith('/nix/store/') === false &&
  (path.includes(`${sep}buck-out${sep}`) === true || path.endsWith(`${sep}buck-out`) === true)

/** Mutable Buck inputs, including symlink carriers, belong to the owned materializer. */
export const requireEditorPublicationInputs = ({
  root,
  paths,
  ownerFd,
}: {
  readonly root: string
  readonly paths: readonly string[]
  readonly ownerFd?: number
}): void => {
  const owned = join(realpathSync(root), 'buck-out', editorPublicationIsolation)
  let ownerValidated = false
  for (const path of paths) {
    const absolute = isAbsolute(path) === true ? path : `${process.cwd()}${sep}${path}`
    const output = `${absolute}${sep}`.indexOf(`${sep}buck-out${sep}`)
    const reached =
      output < 0
        ? undefined
        : join(realpathThroughName(absolute.slice(0, output) || sep), absolute.slice(output + 1))
    // Preserve the reached filename on Darwin; realpathSync may choose another hardlink alias.
    const resolved = realpathThroughName(path)
    const reachedMutable = isMutableBuckPath(reached)
    const resolvedMutable = isMutableBuckPath(resolved)
    if (reachedMutable === false && resolvedMutable === false) continue
    if (ownerValidated === false) {
      requireEditorPublicationOwner({
        root,
        ...(ownerFd === undefined
          ? {}
          : { env: { [editorPublicationOwnerFdEnv]: String(ownerFd) } }),
      })
      ownerValidated = true
    }
    if (
      (reachedMutable === true && reached.startsWith(`${owned}${sep}`) === false) ||
      (resolvedMutable === true && resolved.startsWith(`${owned}${sep}`) === false)
    )
      throw new Error(`Editor publication input is outside its reserved Buck isolation: ${path}`)
  }
}
