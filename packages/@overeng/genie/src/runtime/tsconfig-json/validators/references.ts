/**
 * Tsconfig reference validator.
 *
 * Validates that tsconfig.json references match workspace dependencies.
 * For each workspace dependency in package.json, there should be a corresponding
 * tsconfig reference to enable proper TypeScript project references.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { GenieContext } from '../../mod.ts'
import type { ValidationIssue } from '../../package-json/validation.ts'
import type { TSConfigArgs } from '../mod.ts'

/**
 * Compute relative path from one repo-relative location to another.
 * @param from - Source location (e.g., 'packages/@overeng/genie')
 * @param to - Target location (e.g., 'packages/@overeng/utils')
 * @returns Relative path (e.g., '../utils')
 */
const computeRelativeRef = ({ from, to }: { from: string; to: string }): string => {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const result = '../'.repeat(upCount) + downPath
  return result.endsWith('/') ? result.slice(0, -1) : result
}

/**
 * Validate that tsconfig references match workspace dependencies.
 *
 * Checks that for each workspace dependency in package.json, there is a
 * corresponding tsconfig reference. This ensures proper TypeScript project
 * references for build ordering and type checking.
 */
export const validateTsconfigReferences = ({
  ctx,
  references,
}: {
  ctx: GenieContext
  references: TSConfigArgs['references']
}): ValidationIssue[] => {
  // Need workspace context and location to validate
  if (!ctx.workspace) return []

  const issues: ValidationIssue[] = []
  const currentRefs = new Set((references ?? []).map((r) => r.path))

  // Find current package from location
  const currentPkg = [...ctx.workspace.byName.values()].find((p) => p.path === ctx.location)
  if (!currentPkg) return []

  // Get workspace dependencies (both deps and devDeps)
  const allDeps = {
    ...currentPkg.dependencies,
    ...currentPkg.devDependencies,
  }

  const workspaceDeps = Object.entries(allDeps).filter(
    ([_, version]) => version === 'workspace:*' || version.startsWith('workspace:'),
  )

  // Check each workspace dep has a corresponding tsconfig reference
  for (const [depName] of workspaceDeps) {
    const depPkg = ctx.workspace.byName.get(depName)
    if (!depPkg) continue

    // Skip deps that can't be valid project reference targets:
    // - No tsconfig.json (e.g. meta-packages like peer-deps)
    // - composite: false (e.g. Astro sites, CLI tools)
    const depTsconfigPath = join(ctx.cwd, depPkg.path, 'tsconfig.json')
    if (!existsSync(depTsconfigPath)) continue
    if (!isCompositeProject(depTsconfigPath)) continue

    const expectedRef = computeRelativeRef({ from: ctx.location, to: depPkg.path })
    if (!currentRefs.has(expectedRef)) {
      issues.push({
        severity: 'error',
        packageName: currentPkg.name,
        dependency: depName,
        message: `Missing tsconfig reference "${expectedRef}" for workspace dependency "${depName}"`,
        rule: 'tsconfig-references',
      })
    }
  }

  // Optionally check for extra references (references to packages not in deps)
  // This is less strict - extra references are often intentional for build ordering
  // So we don't report them as issues

  return issues
}

/** Check if a tsconfig.json has composite: true (required for project reference targets). */
const isCompositeProject = (tsconfigPath: string): boolean => {
  try {
    // Resolve typescript from the consumer workspace (not from genie's own location)
    // since genie runtime files may be loaded from a cache outside node_modules.
    const require = createRequire(tsconfigPath)
    // oxlint-disable-next-line typescript-eslint/consistent-type-imports -- dynamic require needs runtime type annotation
    const ts: typeof import('typescript') = require('typescript')
    const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
    if (error || !config) return false
    return config.compilerOptions?.composite !== false
  } catch {
    return false
  }
}
