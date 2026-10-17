/**
 * Node-only tsconfig.json reference projection.
 *
 * `tsconfigJsonFromPackages` discovers tsconfig files on disk (`onlyExistingReferences`), so it lives in the
 * `@overeng/genie/node` entry rather than the isomorphic `.` entry. The pure `tsconfigJson` builder it wraps,
 * and the workspace-graph projection helpers, are imported from the pure runtime.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { tsconfigJson, type GenieOutput, type TSConfigArgs } from '../mod.ts'
import type { WorkspacePackageLike } from '../package-json/mod.ts'
import { rootWorkspaceMemberPathsFromPackages } from '../workspace-graph.ts'

const sortStrings = (values: Iterable<string>) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b))

/** Project a root tsconfig.json references list from package metadata instead of maintaining reference paths manually. */
export const tsconfigJsonFromPackages = ({
  dir,
  packages,
  repoName,
  extraReferences = [],
  onlyExistingReferences = false,
  ...args
}: {
  dir: string
  packages: readonly WorkspacePackageLike[]
  repoName: string
  extraReferences?: readonly string[]
  onlyExistingReferences?: boolean
} & Omit<TSConfigArgs, 'references'>): GenieOutput<TSConfigArgs> => {
  const references = sortStrings([
    ...rootWorkspaceMemberPathsFromPackages({
      packages,
      repoName,
    }),
    ...extraReferences,
  ])

  const normalizedReferences =
    onlyExistingReferences === true
      ? references.filter((referencePath) =>
          existsSync(path.join(dir, referencePath, 'tsconfig.json')),
        )
      : references

  return tsconfigJson({
    ...args,
    references: normalizedReferences.map((referencePath) => ({
      path: `./${referencePath}`,
    })),
  })
}
