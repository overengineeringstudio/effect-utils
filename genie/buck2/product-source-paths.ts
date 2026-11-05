import type { WorkspacePackageLike } from '../../packages/@overeng/genie/src/runtime/package-json/mod.ts'
import { projectPnpmPackageClosure } from '../../packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts'

/**
 * Inputs for a from-source Buck product, projected by Genie alongside its target.
 * Additional packages cover workspace runtimes invoked by Buck (including their
 * transitive pnpm dependencies); additional paths cover non-pnpm inputs. The
 * consumer root, capabilities, lock-derived archives and toolchains are separate
 * Nix inputs. Keep this list in a committed projection, never derive it in Nix
 * from Buck evaluation or from the entire checkout.
 */
export const projectBuckProductSourcePaths = ({
  pkg,
  additionalPackages = [],
  additionalPaths = [],
  rootPaths = ['package.json', 'pnpm-workspace.yaml'],
}: {
  readonly pkg: WorkspacePackageLike
  readonly additionalPackages?: readonly WorkspacePackageLike[]
  readonly additionalPaths?: readonly string[]
  readonly rootPaths?: readonly string[]
}): readonly string[] =>
  [
    ...new Set([
      ...rootPaths,
      ...[pkg, ...additionalPackages].flatMap(
        (entry) => projectPnpmPackageClosure({ pkg: entry }).workspaceClosureDirs,
      ),
      ...additionalPaths,
    ]),
  ].toSorted()
