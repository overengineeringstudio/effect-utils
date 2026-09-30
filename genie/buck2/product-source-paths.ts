import type { WorkspacePackageLike } from '../../packages/@overeng/genie/src/runtime/package-json/mod.ts'
import { projectPnpmPackageClosure } from '../../packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts'

/**
 * Inputs for a from-source Buck product, projected by Genie alongside its target.
 * Additional paths cover non-pnpm Buck inputs (e.g. a Rust workspace); the
 * consumer root, capabilities, lock-derived archives and toolchains are separate
 * Nix inputs. Keep this list in a committed projection, never derive it in Nix
 * from Buck evaluation or from the entire checkout.
 */
export const projectBuckProductSourcePaths = ({
  pkg,
  additionalPaths = [],
  rootPaths = ['package.json', 'pnpm-workspace.yaml'],
}: {
  readonly pkg: WorkspacePackageLike
  readonly additionalPaths?: readonly string[]
  readonly rootPaths?: readonly string[]
}): readonly string[] =>
  [
    ...new Set([
      ...rootPaths,
      ...projectPnpmPackageClosure({ pkg }).workspaceClosureDirs,
      ...additionalPaths,
    ]),
  ].toSorted()
