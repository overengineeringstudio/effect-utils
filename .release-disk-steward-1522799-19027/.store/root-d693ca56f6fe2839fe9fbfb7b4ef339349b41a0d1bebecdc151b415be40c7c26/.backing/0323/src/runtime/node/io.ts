import { existsSync, readFileSync } from 'node:fs'

import type { GenieIO } from '../core.ts'

/**
 * Node-backed {@link GenieIO} implementation injected by the genie engine during validation.
 *
 * This is the single place the otherwise-pure builder/validator closure obtains real filesystem access, so
 * the `@overeng/genie` (`.`) entry can stay isomorphic while validators still read lockfiles/tsconfigs on disk.
 */
export const nodeGenieIO: GenieIO = {
  fileExists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return undefined
    }
  },
}
