import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'

import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
  requireEditorPublicationOwner,
} from './editor-publication-owner.ts'

const isMutableBuckPath = (path: string | undefined): path is string =>
  path !== undefined &&
  path.startsWith('/nix/store/') === false &&
  (path.includes(`${sep}buck-out${sep}`) === true || path.endsWith(`${sep}buck-out`) === true)

/** Mutable Buck inputs, including symlink carriers, belong to the owned materializer. */
export const requireEditorPublicationInputs = ({
  root,
  paths,
  owner,
}: {
  readonly root: string
  readonly paths: readonly string[]
  readonly owner?: EditorPublicationOwner
}): void => {
  const owned = join(realpathSync(root), 'buck-out', editorPublicationIsolation)
  let ownerValidated = false
  for (const path of paths) {
    const absolute = isAbsolute(path) === true ? path : `${process.cwd()}${sep}${path}`
    const pending = absolute.split(sep).filter((component) => component.length > 0)
    if (absolute.endsWith(sep) === true) pending.push('.')
    let resolved: string = sep
    let hops = 0
    let mutable = false
    let outside = false
    while (pending.length > 0) {
      const component = pending.shift()!
      if (component === '.') continue
      if (component === '..') {
        resolved = dirname(resolved)
        continue
      }
      const candidate = join(resolved, component)
      if (isMutableBuckPath(candidate) === true) {
        mutable = true
        // Inspect a Buck directory before following it, including directory symlinks.
        const allowed =
          candidate === dirname(owned)
            ? pending.find((part) => part !== '.') === editorPublicationIsolation
            : candidate === owned
              ? pending.length > 0
              : candidate.startsWith(`${owned}${sep}`)
        outside ||= allowed === false
      }
      const status = lstatSync(candidate)
      if (status.isSymbolicLink() === true) {
        if (++hops > 40)
          throw Object.assign(new Error(`too many symbolic links: ${path}`), { code: 'ELOOP' })
        const target = readlinkSync(candidate)
        if (isAbsolute(target) === true) resolved = sep
        const components = target.split(sep).filter((part) => part.length > 0)
        if (target.endsWith(sep) === true) components.push('.')
        pending.unshift(...components)
      } else {
        if (pending.length > 0 && status.isDirectory() === false)
          throw Object.assign(new Error(`not a directory: ${candidate}`), { code: 'ENOTDIR' })
        // Keep the reached filename: Darwin realpath may report a different hardlink.
        resolved = candidate
      }
    }
    // Finish filesystem traversal first so native resolution failures remain visible.
    if (mutable === false) continue
    if (ownerValidated === false) {
      requireEditorPublicationOwner({ root, owner })
      ownerValidated = true
    }
    if (outside === true)
      throw new Error(`Editor publication input is outside its reserved Buck isolation: ${path}`)
  }
}
