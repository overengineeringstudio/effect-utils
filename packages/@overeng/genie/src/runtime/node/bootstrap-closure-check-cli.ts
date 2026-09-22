import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { parseGeneratorPhase } from '../../core/phase.ts'
import type { BootstrapClosureViolation } from './bootstrap-closure.ts'
import { checkBootstrapClosure, formatViolationChain } from './bootstrap-closure.ts'

const usage = `Usage:
  genie-bootstrap-closure-check [--root <repo-root>]
  genie-bootstrap-closure-check [--root <repo-root>] \\
    --editor-view-root-package-path <workspace-path> \\
    --editor-view-package-paths <json-array>

Checks source-tree // @genie-bootstrap .genie.ts files for runtime-only package imports.
With the editor-view arguments, checks every generator's runtime import closure against the
workspace package views published before genie:check.`

const ignoredDiscoveryDirs = new Set([
  '.devenv',
  '.direnv',
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'result',
  'target',
])

type WorkspacePackage = {
  readonly name: string
  readonly path: string
}

type EditorViewClosureViolation = {
  readonly packageName: string
  readonly packagePath: string
  readonly violation: BootstrapClosureViolation
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const decodePackagePaths = (serialized: string): readonly string[] => {
  const decoded: unknown = JSON.parse(serialized)
  if (
    Array.isArray(decoded) === false ||
    decoded.length === 0 ||
    decoded.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('--editor-view-package-paths must be a non-empty JSON array of strings')
  }
  return decoded
}

const packageNameFromSpecifier = (specifier: string): string => {
  const segments = specifier.split('/')
  return specifier.startsWith('@') === true ? segments.slice(0, 2).join('/') : segments[0]!
}

const readWorkspacePackages = (repoRoot: string): readonly WorkspacePackage[] => {
  const rootManifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (isObject(rootManifest) === false || Array.isArray(rootManifest.workspaces) === false) {
    throw new Error('root package.json must declare a workspaces array')
  }

  return rootManifest.workspaces.map((packagePath) => {
    if (typeof packagePath !== 'string') {
      throw new Error('root package.json workspaces must contain only package paths')
    }
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repoRoot, packagePath, 'package.json'), 'utf8'),
    )
    if (isObject(manifest) === false || typeof manifest.name !== 'string') {
      throw new Error(`${packagePath}/package.json must declare a package name`)
    }
    return { name: manifest.name, path: packagePath }
  })
}

export const findEditorViewClosureViolations = ({
  violations,
  workspacePackages,
  publishedPackagePaths,
  repoRoot,
  rootPackagePath,
}: {
  readonly violations: readonly BootstrapClosureViolation[]
  readonly workspacePackages: readonly WorkspacePackage[]
  readonly publishedPackagePaths: readonly string[]
  readonly repoRoot: string
  readonly rootPackagePath: string
}): readonly EditorViewClosureViolation[] => {
  const packageByName = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  )
  const packageByPath = new Map(
    workspacePackages.map((workspacePackage) => [workspacePackage.path, workspacePackage]),
  )
  const publishedWorkspacePaths = new Set<string>()
  for (const packagePath of publishedPackagePaths) {
    const workspacePath = packagePath === '.' ? rootPackagePath : packagePath
    if (packageByPath.has(workspacePath) === false) {
      throw new Error(
        `--editor-view-package-paths names an unknown workspace package: ${workspacePath}`,
      )
    }
    publishedWorkspacePaths.add(workspacePath)
  }

  return violations.flatMap((violation) => {
    const importer = violation.chain[violation.chain.length - 1]!
    const importerPackage = workspacePackages.find((workspacePackage) => {
      const relative = path.relative(path.join(repoRoot, workspacePackage.path), importer)
      return (
        relative === '' ||
        (relative.startsWith('..') === false && path.isAbsolute(relative) === false)
      )
    })
    const requiredPackage =
      importerPackage ?? packageByName.get(packageNameFromSpecifier(violation.specifier))
    return requiredPackage === undefined ||
      publishedWorkspacePaths.has(requiredPackage.path) === true
      ? []
      : [
          {
            packageName: requiredPackage.name,
            packagePath: requiredPackage.path,
            violation,
          },
        ]
  })
}

const parseArgs = ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): {
  readonly repoRoot: string
  readonly help: boolean
  readonly editorViewPackagePaths: readonly string[] | undefined
  readonly editorViewRootPackagePath: string | undefined
} => {
  let repoRoot = defaultRepoRoot
  let help = false
  let editorViewPackagePaths: readonly string[] | undefined
  let editorViewRootPackagePath: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--root requires a non-empty path')
      }
      repoRoot = path.resolve(value)
      index += 1
      continue
    }
    if (arg === '--editor-view-package-paths') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--editor-view-package-paths requires a non-empty JSON array')
      }
      editorViewPackagePaths = decodePackagePaths(value)
      index += 1
      continue
    }
    if (arg === '--editor-view-root-package-path') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--editor-view-root-package-path requires a non-empty workspace path')
      }
      editorViewRootPackagePath = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  if ((editorViewPackagePaths === undefined) !== (editorViewRootPackagePath === undefined)) {
    throw new Error(
      '--editor-view-package-paths and --editor-view-root-package-path must be provided together',
    )
  }
  // The walk reports every path as its on-disk identity, so the root the diagnostics are made relative
  // to has to be that same identity — otherwise a symlinked checkout renders every chain as `../..`.
  return {
    repoRoot: existsSync(repoRoot) === true ? realpathSync.native(repoRoot) : repoRoot,
    help,
    editorViewPackagePaths,
    editorViewRootPackagePath,
  }
}

/** Discover source-tree `.genie.ts` files without requiring Git or package-manager install state. */
export const discoverGenieFiles = (repoRoot: string): readonly string[] => {
  const files: string[] = []

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() === true) continue

      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory() === true) {
        if (ignoredDiscoveryDirs.has(entry.name) === false) visit(entryPath)
        continue
      }

      if (entry.isFile() === true && entry.name.endsWith('.genie.ts') === true) {
        files.push(entryPath)
      }
    }
  }

  visit(repoRoot)
  return files.toSorted()
}

/**
 * Runs the standalone bootstrap import-closure checker CLI.
 */
export const bootstrapClosureCheckMain = async ({
  argv,
  defaultRepoRoot,
}: {
  argv: readonly string[]
  defaultRepoRoot: string
}): Promise<void> => {
  try {
    const { repoRoot, help, editorViewPackagePaths, editorViewRootPackagePath } = parseArgs({
      argv,
      defaultRepoRoot,
    })
    if (help === true) {
      console.log(usage)
      return
    }

    const allGenieFiles = discoverGenieFiles(repoRoot)
    if (editorViewPackagePaths !== undefined && editorViewRootPackagePath !== undefined) {
      const result = await checkBootstrapClosure({
        genieFiles: allGenieFiles,
        reportAllViolations: true,
      })
      const closureViolations = findEditorViewClosureViolations({
        violations: result.violations,
        workspacePackages: readWorkspacePackages(repoRoot),
        publishedPackagePaths: editorViewPackagePaths,
        repoRoot,
        rootPackagePath: editorViewRootPackagePath,
      })
      if (closureViolations.length > 0) {
        console.error(
          `✗ editor-view-closure: ${closureViolations.length} generator import(s) require an unpublished workspace package view:\n`,
        )
        for (const closureViolation of closureViolations) {
          console.error(
            `  ${formatViolationChain({ violation: closureViolation.violation, repoRoot })}\n` +
              `    missing editor view: ${closureViolation.packagePath} (${closureViolation.packageName})\n`,
          )
        }
        console.error(
          'Add every listed package path to the editorBootstrapPackagePaths declaration so ' +
            'buck2:editor:bootstrap publishes the complete generator import closure before genie:check.',
        )
        process.exit(1)
      }
      console.log(
        `editor-view-closure: OK — ${result.checkedSources.length} .genie.ts runtime import closures ` +
          `are covered by ${editorViewPackagePaths.length} bootstrap editor view(s)`,
      )
      return
    }

    const bootstrapFiles = allGenieFiles.filter(
      (file) => parseGeneratorPhase(readFileSync(file, 'utf8')) === 'bootstrap',
    )

    const { violations, checkedSources } = await checkBootstrapClosure({
      genieFiles: bootstrapFiles,
    })

    if (violations.length > 0) {
      console.error(
        `✗ bootstrap-closure: ${violations.length} bootstrap-phase generator(s) reach a runtime-only package:\n`,
      )
      for (const violation of violations) {
        console.error(`  ${formatViolationChain({ violation, repoRoot })}\n`)
      }
      console.error(
        'A `bootstrap`-phase `.genie.ts` must be importable from a fresh checkout BEFORE install. ' +
          'Narrow the import (avoid wide barrels that reach runtime-only packages), or — if the ' +
          'generator genuinely needs the runtime graph — remove its `// @genie-bootstrap` pragma ' +
          'so it runs post-install as a design-time generator (and ensure no install step depends on its output).',
      )
      process.exit(1)
    }

    console.log(
      `bootstrap-closure: OK — ${checkedSources.length} bootstrap-phase .genie.ts checked, no violations ` +
        `(${allGenieFiles.length - bootstrapFiles.length} design-time generator(s) out of scope by declaration)`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`bootstrap-closure: ${message}`)
    process.exit(1)
  }
}
