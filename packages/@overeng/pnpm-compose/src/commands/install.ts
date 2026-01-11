import * as Cli from '@effect/cli'
import { Command, Error as PlatformError, FileSystem, Path } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Console, Effect, Option, Schema } from 'effect'
import type { Scope } from 'effect/Scope'

import { CatalogReadError, findCatalogConflicts, readRepoCatalog } from '../catalog.ts'
import { ConfigLoadError, ConfigValidationError, detectComposedRepos } from '../config.ts'
import {
  findAllSubmodules,
  findDuplicates,
  pickCanonicalSubmodule,
  updateSubmoduleWithSymlink,
} from '../submodule-dedupe.ts'

/** Install command: runs the linking dance for composed repos */
/** Parsed config for the install command */
export type InstallCommandConfig = {
  skipCatalogCheck: boolean
  clean: boolean
}

type InstallCommandEnv =
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | Scope

type InstallCommandError =
  | CatalogReadError
  | ConfigLoadError
  | ConfigValidationError
  | PackageJsonParseError
  | InstallFailedError
  | PlatformError.PlatformError

export const installCommand: Cli.Command.Command<
  'install',
  InstallCommandEnv,
  InstallCommandError,
  InstallCommandConfig
> = Cli.Command.make(
  'install',
  {
    skipCatalogCheck: Cli.Options.boolean('skip-catalog-check').pipe(
      Cli.Options.withDescription('Skip catalog alignment check'),
      Cli.Options.withDefault(false),
    ),
    clean: Cli.Options.boolean('clean').pipe(
      Cli.Options.withDescription('Force clean install (remove node_modules first)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ skipCatalogCheck, clean }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const fs = yield* FileSystem.FileSystem

      // Auto-detect composed repos from .gitmodules
      const composedRepos = yield* detectComposedRepos(cwd)

      if (composedRepos.length === 0) {
        yield* Console.log('No composed repos detected (no git submodules found)')
        return
      }

      // Step 0: Deduplicate git submodules via symlinks (canonical working tree)
      yield* Effect.gen(function* () {
        const allSubmodules = yield* findAllSubmodules(cwd)
        if (allSubmodules.length === 0) return

        const duplicates = findDuplicates(allSubmodules)
        if (duplicates.length === 0) return

        yield* Console.log(
          `Deduplicating ${duplicates.length} duplicate submodule(s) via symlinks...`,
        )

        let symlinkCount = 0
        for (const dup of duplicates) {
          const canonical = yield* pickCanonicalSubmodule(dup)
          for (const loc of dup.locations) {
            if (loc === canonical) continue

            yield* updateSubmoduleWithSymlink({ canonical, target: loc })
            symlinkCount += 1
          }
        }

        yield* Console.log(`  ✓ Symlinked ${symlinkCount} submodule(s) to canonical`)
        yield* Console.log('')

        // Provide a compact tree of canonical submodules and their symlinked duplicates.
        const path = yield* Path.Path
        yield* Console.log('Submodules:')
        for (const dup of duplicates) {
          const canonical = yield* pickCanonicalSubmodule(dup)
          const canonicalPath = path.join(canonical.repoRoot, canonical.path)
          const canonicalRel = path.relative(cwd, canonicalPath)
          yield* Console.log(`- ${canonicalRel} (canonical)`)

          for (const loc of dup.locations) {
            if (loc === canonical) continue
            const targetPath = path.join(loc.repoRoot, loc.path)
            const targetRel = path.relative(cwd, targetPath)
            const linkRel = path.relative(path.dirname(targetPath), canonicalPath)
            yield* Console.log(`  - ${targetRel} -> ${linkRel}`)
          }
        }
        yield* Console.log('')
      }).pipe(
        Effect.catchAll((error) =>
          Console.log(`  ⚠ Submodule deduplication via symlink skipped (${error})\n`),
        ),
      )

      // Step 1: Check for rogue pnpm state in submodules (corruption detection)
      // This happens when someone accidentally runs `pnpm install` in a submodule
      // We look for pnpm-specific files (.modules.yaml or .pnpm directory) to distinguish
      // from legitimate node_modules created by other tools (bun, etc.)
      const rogueNodeModules: string[] = []
      for (const repo of composedRepos) {
        const modulesYamlPath = `${cwd}/${repo.path}/node_modules/.modules.yaml`
        const pnpmDirPath = `${cwd}/${repo.path}/node_modules/.pnpm`
        const hasModulesYaml = yield* fs.exists(modulesYamlPath)
        const hasPnpmDir = yield* fs.exists(pnpmDirPath)
        if (hasModulesYaml || hasPnpmDir) {
          rogueNodeModules.push(repo.path)
        }
      }

      if (rogueNodeModules.length > 0) {
        yield* Console.log('⚠ Detected node_modules in submodules (workspace corruption):')
        for (const path of rogueNodeModules) {
          yield* Console.log(`  - ${path}/node_modules`)
        }
        yield* Console.log('')
        yield* Console.log('This usually happens when `pnpm install` is run inside a submodule.')
        yield* Console.log('Auto-cleaning to restore workspace integrity...\n')

        for (const path of rogueNodeModules) {
          const nmPath = `${cwd}/${path}/node_modules`
          yield* fs.remove(nmPath, { recursive: true })
          yield* Console.log(`  ✓ Removed ${path}/node_modules`)
        }
        yield* Console.log('')
      }

      // Step 2: Check catalog alignment (unless skipped)
      if (!skipCatalogCheck) {
        yield* Console.log('Checking catalog alignment...')
        const catalogs = []

        const mainCatalog = yield* readRepoCatalog({ repoName: 'main', repoPath: cwd })
        if (Option.isSome(mainCatalog)) {
          catalogs.push(mainCatalog.value)
        }

        for (const repo of composedRepos) {
          const repoPath = `${cwd}/${repo.path}`
          const repoCatalog = yield* readRepoCatalog({ repoName: repo.name, repoPath })
          if (Option.isSome(repoCatalog)) {
            catalogs.push(repoCatalog.value)
          }
        }

        const conflicts = findCatalogConflicts(catalogs)
        if (conflicts.length > 0) {
          yield* Console.log(`\n✗ Found ${conflicts.length} catalog conflict(s):`)
          for (const conflict of conflicts) {
            yield* Console.log(
              `  ${conflict.packageName}: ${conflict.versions.map((v) => `${v.repoName}@${v.version}`).join(' vs ')}`,
            )
            yield* Console.log(`    → Suggestion: update all to ${conflict.highestVersion}`)
          }
          yield* Console.log('\nRun with --skip-catalog-check to proceed anyway (not recommended)')
          return yield* new InstallFailedError({ reason: 'catalog conflicts' })
        }
        yield* Console.log('  ✓ Catalogs aligned\n')
      }

      const nodeModulesPath = `${cwd}/node_modules`
      const nodeModulesExists = yield* fs.exists(nodeModulesPath)

      // Collect expected symlinks for composed repo packages
      const expectedSymlinks: Array<{
        pkgName: string
        targetPath: string
        sourcePath: string
        repoPath: string
        relativePath: string
      }> = []

      // Track package names to detect duplicates across repos
      const packageSources = new Map<string, { repoPath: string; relativePath: string }>()
      const duplicates: Array<{ pkgName: string; sources: string[] }> = []

      for (const repo of composedRepos) {
        const repoPath = `${cwd}/${repo.path}`
        const packages = yield* findPackagesInRepo(repoPath)
        for (const pkg of packages) {
          const existing = packageSources.get(pkg.name)
          if (existing) {
            // Found duplicate - collect all sources
            const existingDup = duplicates.find((d) => d.pkgName === pkg.name)
            if (existingDup) {
              existingDup.sources.push(`${repo.path}/${pkg.relativePath}`)
            } else {
              duplicates.push({
                pkgName: pkg.name,
                sources: [
                  `${existing.repoPath}/${existing.relativePath}`,
                  `${repo.path}/${pkg.relativePath}`,
                ],
              })
            }
          } else {
            packageSources.set(pkg.name, { repoPath: repo.path, relativePath: pkg.relativePath })
            expectedSymlinks.push({
              pkgName: pkg.name,
              targetPath: `${cwd}/node_modules/${pkg.name}`,
              sourcePath: pkg.path,
              repoPath: repo.path,
              relativePath: pkg.relativePath,
            })
          }
        }
      }

      // Fail if duplicate package names found across repos
      if (duplicates.length > 0) {
        yield* Console.log('✗ Found duplicate package names across composed repos:\n')
        for (const dup of duplicates) {
          yield* Console.log(`  ${dup.pkgName}:`)
          for (const source of dup.sources) {
            yield* Console.log(`    - ${source}`)
          }
        }
        yield* Console.log('\nEach package name must be unique across all composed repos.')
        return yield* new InstallFailedError({ reason: 'duplicate package names across repos' })
      }

      /**
       * Find which symlinks need fixing.
       * Returns list of symlinks that are missing or pointing to wrong target.
       */
      const findWrongSymlinks = Effect.gen(function* () {
        const wrong: typeof expectedSymlinks = []
        for (const link of expectedSymlinks) {
          const target = yield* fs.readLink(link.targetPath).pipe(Effect.option)
          if (Option.isNone(target) || target.value !== link.sourcePath) {
            wrong.push(link)
          }
        }
        return wrong
      })

      const wrongSymlinks = nodeModulesExists ? yield* findWrongSymlinks : expectedSymlinks

      /**
       * Install strategy:
       *
       * 1. **All symlinks correct** → skip entirely (most common case)
       * 2. **Some symlinks wrong, node_modules exists** → fix only wrong symlinks + lockfile-only
       * 3. **No node_modules or --clean flag** → full install dance
       *
       * The incremental approach (case 2) works because:
       * - `pnpm install --lockfile-only` preserves existing symlinks
       * - We only need to fix the specific symlinks that are wrong
       * - No need to remove node_modules just to fix a few symlinks
       *
       * Full clean install (case 3) is only needed when:
       * - node_modules doesn't exist (fresh clone)
       * - User explicitly requests --clean
       * - pnpm's internal state is corrupted (rare, usually from running pnpm install in child repo)
       */
      const shouldFullInstall = !nodeModulesExists || clean
      const shouldFixSymlinks = !shouldFullInstall && wrongSymlinks.length > 0
      const shouldSkipInstall = !shouldFullInstall && !shouldFixSymlinks

      if (shouldSkipInstall) {
        yield* Console.log('✓ Symlinks already correct, skipping install\n')
      }

      // Case 3: Full install dance (no node_modules or --clean)
      if (shouldFullInstall) {
        if (nodeModulesExists) {
          yield* Console.log('Removing node_modules...')
          yield* fs.remove(nodeModulesPath, { recursive: true })
          yield* Console.log('  ✓ Removed\n')
        }

        yield* Console.log('Running pnpm install...')
        yield* runCommand({ cmd: 'pnpm', args: ['install'], cwd })
        yield* Console.log('  ✓ Done\n')

        yield* Console.log('Symlinking composed repo packages...')
        for (const link of expectedSymlinks) {
          yield* createSymlink({
            fs,
            targetPath: link.targetPath,
            sourcePath: link.sourcePath,
            pkgName: link.pkgName,
          })
          yield* Console.log(`  ✓ ${link.pkgName} → ${link.repoPath}/${link.relativePath}`)
        }
        yield* Console.log('')

        yield* Console.log('Updating lockfile...')
        yield* runCommand({ cmd: 'pnpm', args: ['install', '--lockfile-only'], cwd })
        yield* Console.log('  ✓ Done\n')
      }

      // Case 2: Incremental fix (node_modules exists, some symlinks wrong)
      if (shouldFixSymlinks) {
        yield* Console.log(`Fixing ${wrongSymlinks.length} symlink(s)...`)
        for (const link of wrongSymlinks) {
          yield* createSymlink({
            fs,
            targetPath: link.targetPath,
            sourcePath: link.sourcePath,
            pkgName: link.pkgName,
          })
          yield* Console.log(`  ✓ ${link.pkgName} → ${link.repoPath}/${link.relativePath}`)
        }
        yield* Console.log('')

        yield* Console.log('Updating lockfile...')
        yield* runCommand({ cmd: 'pnpm', args: ['install', '--lockfile-only'], cwd })
        yield* Console.log('  ✓ Done\n')
      }

      yield* syncSubmoduleRootNodeModules({
        cwd,
        composedRepos,
      })

      yield* writePnpmComposeEnvFiles({ cwd, composedRepos })

      yield* Console.log('✓ Install complete')
    }).pipe(Effect.withSpan('install')),
).pipe(Cli.Command.withDescription('Run the linking dance for composed repos'))

/** Create symlink, removing existing if needed */
const createSymlink = ({
  fs,
  targetPath,
  sourcePath,
  pkgName,
}: {
  fs: FileSystem.FileSystem
  targetPath: string
  sourcePath: string
  pkgName: string
}) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(targetPath)
    if (exists) {
      yield* fs.remove(targetPath, { recursive: true })
    }

    // Create parent dir if scoped package
    if (pkgName.includes('/')) {
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'))
      yield* fs.makeDirectory(parentDir, { recursive: true })
    }

    yield* fs.symlink(sourcePath, targetPath)
  })

/** Run a command and stream output */
const runCommand = ({ cmd, args, cwd }: { cmd: string; args: string[]; cwd: string }) =>
  Effect.gen(function* () {
    const command = Command.make(cmd, ...args).pipe(Command.workingDirectory(cwd))

    const process = yield* Command.start(command)
    const exitCode = yield* process.exitCode

    if (exitCode !== 0) {
      return yield* new InstallFailedError({
        reason: `${cmd} ${args.join(' ')} failed with exit code ${exitCode}`,
      })
    }
  })

/** Package info from a composed repo */
interface PackageInfo {
  name: string
  path: string
  relativePath: string
}

/** Root package.json info used for submodule dependency linking. */
interface RootPackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  bin?: string | Record<string, string>
}

/** Find all packages in a repo */
const findPackagesInRepo = (repoPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packages: PackageInfo[] = []

    // Auto-detect workspace globs from pnpm-workspace.yaml
    const globs = yield* detectWorkspaceGlobs(repoPath)

    for (const glob of globs) {
      // Simple glob expansion (handles patterns like "packages/*" and "packages/@*/*")
      const expanded = yield* expandGlob({ basePath: repoPath, glob })

      for (const pkgDir of expanded) {
        const pkgJsonPath = `${pkgDir}/package.json`
        const exists = yield* fs.exists(pkgJsonPath)
        if (!exists) continue

        const content = yield* fs.readFileString(pkgJsonPath)
        const parsed = yield* Effect.try({
          try: () => JSON.parse(content) as { name?: string; private?: boolean },
          catch: (cause) => new PackageJsonParseError({ path: pkgJsonPath, cause }),
        })

        // Include all named packages (private or not) - we want local source for development
        if (parsed.name) {
          packages.push({
            name: parsed.name,
            path: pkgDir,
            relativePath: pkgDir.replace(`${repoPath}/`, ''),
          })
        }
      }
    }

    return packages
  })

/** Detect workspace globs from pnpm-workspace.yaml */
const detectWorkspaceGlobs = (repoPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const workspacePath = `${repoPath}/pnpm-workspace.yaml`

    const exists = yield* fs.exists(workspacePath)
    if (!exists) {
      return ['packages/*', 'packages/@*/*']
    }

    const content = yield* fs.readFileString(workspacePath)

    // Simple YAML parsing for packages section
    const packagesMatch = content.match(/^packages:\s*\n((?:\s+-\s+.+\n?)*)/m)
    if (!packagesMatch) {
      return ['packages/*', 'packages/@*/*']
    }

    const lines = packagesMatch[1]?.split('\n').filter((line) => line.trim()) ?? []
    const globs: string[] = []

    for (const line of lines) {
      const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?/)
      if (match && match[1]) {
        globs.push(match[1])
      }
    }

    return globs.length > 0 ? globs : ['packages/*', 'packages/@*/*']
  })

/** Expand a simple glob pattern */
const expandGlob = ({ basePath, glob }: { basePath: string; glob: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Handle patterns like "packages/*" and "packages/@*/*"
    const parts = glob.split('/')
    let currentPaths = [basePath]

    for (const part of parts) {
      const nextPaths: string[] = []

      for (const currentPath of currentPaths) {
        if (part === '*' || part === '@*') {
          // List directory and filter
          const exists = yield* fs.exists(currentPath)
          if (!exists) continue

          const entries = yield* fs.readDirectory(currentPath)
          for (const entry of entries) {
            if (part === '@*' && !entry.startsWith('@')) continue
            if (entry.startsWith('.')) continue

            const fullPath = `${currentPath}/${entry}`
            const stat = yield* fs.stat(fullPath)
            if (stat.type === 'Directory') {
              nextPaths.push(fullPath)
            }
          }
        } else {
          // Literal path part
          const fullPath = `${currentPath}/${part}`
          const exists = yield* fs.exists(fullPath)
          if (exists) {
            nextPaths.push(fullPath)
          }
        }
      }

      currentPaths = nextPaths
    }

    return currentPaths
  })

/**
 * Ensure submodule root node_modules only contains direct deps/devDeps symlinked
 * to the workspace root node_modules, and .bin entries are linked per required dep.
 */
const syncSubmoduleRootNodeModules = ({
  cwd,
  composedRepos,
}: {
  cwd: string
  composedRepos: Array<{ name: string; path: string }>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const rootNodeModules = path.join(cwd, 'node_modules')
    const rootBinDir = path.join(rootNodeModules, '.bin')

    const rootNodeModulesExists = yield* fs.exists(rootNodeModules)
    if (!rootNodeModulesExists) {
      return yield* new InstallFailedError({ reason: 'root node_modules missing' })
    }

    const missingByRepo: Array<{
      repoPath: string
      deps: string[]
      bins: string[]
    }> = []
    let linkCount = 0
    let binCount = 0

    for (const repo of composedRepos) {
      const repoRoot = path.join(cwd, repo.path)
      const pkgJsonPath = path.join(repoRoot, 'package.json')
      const pkgExists = yield* fs.exists(pkgJsonPath)
      if (!pkgExists) continue

      const repoPkg = yield* readPackageJson(pkgJsonPath)
      const deps = Object.keys(repoPkg.dependencies ?? {})
      const devDeps = Object.keys(repoPkg.devDependencies ?? {})
      const directDeps = Array.from(new Set([...deps, ...devDeps]))

      const expectedBins = new Set<string>()
      const missingDeps: string[] = []
      const missingBins: string[] = []

      for (const dep of directDeps) {
        const depPath = path.join(rootNodeModules, dep)
        const depExists = yield* fs.exists(depPath)
        if (!depExists) {
          missingDeps.push(dep)
          continue
        }

        const depPkgPath = path.join(depPath, 'package.json')
        const depPkgExists = yield* fs.exists(depPkgPath)
        if (!depPkgExists) {
          continue
        }

        const depPkg = yield* readPackageJson(depPkgPath)
        for (const binName of resolveBinNames({ pkg: depPkg, fallbackName: dep })) {
          expectedBins.add(binName)
          const binPath = path.join(rootBinDir, binName)
          const binExists = yield* fs.exists(binPath)
          if (!binExists) {
            missingBins.push(binName)
          }
        }
      }

      if (missingDeps.length > 0 || missingBins.length > 0) {
        missingByRepo.push({ repoPath: repo.path, deps: missingDeps, bins: missingBins })
        continue
      }

      const submoduleNodeModules = path.join(repoRoot, 'node_modules')
      const existingLink = yield* fs.readLink(submoduleNodeModules).pipe(Effect.option)
      if (Option.isSome(existingLink)) {
        yield* fs.remove(submoduleNodeModules, { recursive: true })
      }
      yield* fs.makeDirectory(submoduleNodeModules, { recursive: true })

      const expectedPackages = new Set(directDeps)
      const expectedScopes = new Map<string, Set<string>>()
      for (const dep of expectedPackages) {
        if (!dep.startsWith('@')) continue
        const [scope, name] = dep.split('/')
        if (!scope || !name) continue
        const scopeSet = expectedScopes.get(scope) ?? new Set<string>()
        scopeSet.add(name)
        expectedScopes.set(scope, scopeSet)
      }

      yield* cleanupSubmoduleNodeModules({
        fs,
        path,
        nodeModulesPath: submoduleNodeModules,
        expectedPackages,
        expectedScopes,
      })

      for (const dep of expectedPackages) {
        yield* createSymlink({
          fs,
          targetPath: path.join(submoduleNodeModules, dep),
          sourcePath: path.join(rootNodeModules, dep),
          pkgName: dep,
        })
        linkCount += 1
      }

      const submoduleBinDir = path.join(submoduleNodeModules, '.bin')
      yield* fs.makeDirectory(submoduleBinDir, { recursive: true })

      yield* cleanupBinEntries({
        fs,
        path,
        binDir: submoduleBinDir,
        expectedBins,
      })

      for (const binName of expectedBins) {
        yield* createSymlink({
          fs,
          targetPath: path.join(submoduleBinDir, binName),
          sourcePath: path.join(rootBinDir, binName),
          pkgName: binName,
        })
        binCount += 1
      }
    }

    if (missingByRepo.length > 0) {
      yield* Console.log('✗ Missing root dependencies for submodule roots:\n')
      for (const missing of missingByRepo) {
        if (missing.deps.length > 0) {
          yield* Console.log(`  - ${missing.repoPath}: ${missing.deps.join(', ')}`)
        }
        if (missing.bins.length > 0) {
          yield* Console.log(`    missing .bin: ${missing.bins.join(', ')}`)
        }
      }
      yield* Console.log(
        '\nEnsure these dependencies are installed at the workspace root and re-run pnpm-compose.',
      )
      return yield* new InstallFailedError({ reason: 'missing root dependencies for submodules' })
    }

    if (linkCount > 0 || binCount > 0) {
      yield* Console.log(`Linked ${linkCount} submodule root deps and ${binCount} .bin entries\n`)
    }
  })

/** Read a package.json file and parse it safely. */
const readPackageJson = (packageJsonPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(packageJsonPath)
    return yield* Effect.try({
      try: () => JSON.parse(content) as RootPackageJson,
      catch: (cause) => new PackageJsonParseError({ path: packageJsonPath, cause }),
    })
  })

/** Resolve bin names for a dependency package. */
const resolveBinNames = ({
  pkg,
  fallbackName,
}: {
  pkg: RootPackageJson
  fallbackName: string
}): string[] => {
  const bin = pkg.bin
  if (!bin) return []
  if (typeof bin === 'string') {
    const name = pkg.name ?? fallbackName
    return [normalizeBinName(name)]
  }
  return Object.keys(bin)
}

/** Scoped package bin names default to the unscoped segment. */
const normalizeBinName = (pkgName: string) =>
  pkgName.startsWith('@') ? (pkgName.split('/')[1] ?? pkgName) : pkgName

/** Remove stale submodule node_modules entries before relinking. */
const cleanupSubmoduleNodeModules = ({
  fs,
  path,
  nodeModulesPath,
  expectedPackages,
  expectedScopes,
}: {
  fs: FileSystem.FileSystem
  path: Path.Path
  nodeModulesPath: string
  expectedPackages: Set<string>
  expectedScopes: Map<string, Set<string>>
}) =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(nodeModulesPath)
    for (const entry of entries) {
      if (entry === '.bin') continue
      if (entry === '.pnpm-compose.env') continue
      if (entry.startsWith('.')) {
        yield* fs.remove(path.join(nodeModulesPath, entry), { recursive: true })
        continue
      }

      if (entry.startsWith('@')) {
        const expectedScoped = expectedScopes.get(entry)
        const scopePath = path.join(nodeModulesPath, entry)
        if (!expectedScoped || expectedScoped.size === 0) {
          yield* fs.remove(scopePath, { recursive: true })
          continue
        }

        const scopedEntries = yield* fs.readDirectory(scopePath)
        for (const scopedEntry of scopedEntries) {
          if (!expectedScoped.has(scopedEntry)) {
            yield* fs.remove(path.join(scopePath, scopedEntry), { recursive: true })
          }
        }

        const remaining = yield* fs.readDirectory(scopePath)
        if (remaining.length === 0) {
          yield* fs.remove(scopePath, { recursive: true })
        }
        continue
      }

      if (!expectedPackages.has(entry)) {
        yield* fs.remove(path.join(nodeModulesPath, entry), { recursive: true })
      }
    }
  })

const writePnpmComposeEnvFiles = Effect.fn('write-pnpm-compose-env-files')(
  ({ cwd, composedRepos }: { cwd: string; composedRepos: Array<{ name: string; path: string }> }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const rootPath = yield* fs.realPath(cwd).pipe(Effect.catchAll(() => Effect.succeed(cwd)))
      const effectUtilsRepo = composedRepos.find((repo) => repo.name === 'effect-utils')
      const effectUtilsPath = effectUtilsRepo
        ? yield* fs
            .realPath(path.join(cwd, effectUtilsRepo.path))
            .pipe(Effect.catchAll(() => Effect.succeed(path.join(cwd, effectUtilsRepo.path))))
        : undefined

      const envText = buildPnpmComposeEnvText({
        rootPath,
        effectUtilsPath,
      })

      const targets = [
        path.join(cwd, 'node_modules'),
        ...composedRepos.map((repo) => path.join(cwd, repo.path, 'node_modules')),
      ]

      for (const nodeModulesPath of targets) {
        yield* fs.makeDirectory(nodeModulesPath, { recursive: true })
        yield* fs.writeFileString(path.join(nodeModulesPath, '.pnpm-compose.env'), envText)
      }
    }),
)

const buildPnpmComposeEnvText = ({
  rootPath,
  effectUtilsPath,
}: {
  rootPath: string
  effectUtilsPath: string | undefined
}) => {
  const lines = [
    '# Generated by pnpm-compose install. Do not edit.',
    '# Format: dotenv-compatible KEY=VALUE pairs for direnv source_env.',
    'PNPM_COMPOSE_ENV_FORMAT=1',
    `PNPM_COMPOSE_ROOT=${quoteEnvValue(rootPath)}`,
    `PNPM_COMPOSE_GENERATED_AT=${quoteEnvValue(formatLocalTimestamp())}`,
  ]

  if (effectUtilsPath) {
    lines.push(`EFFECT_UTILS_OVERRIDE=${quoteEnvValue(effectUtilsPath)}`)
  }

  return `${lines.join('\n')}\n`
}

const quoteEnvValue = (value: string) => `"${value.replaceAll('"', '\\"')}"`

const formatLocalTimestamp = () => {
  const now = new Date()
  const pad = (value: number) => value.toString().padStart(2, '0')
  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-')
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${datePart}-${timePart}`
}

/** Remove stale .bin entries before relinking. */
const cleanupBinEntries = ({
  fs,
  path,
  binDir,
  expectedBins,
}: {
  fs: FileSystem.FileSystem
  path: Path.Path
  binDir: string
  expectedBins: Set<string>
}) =>
  Effect.gen(function* () {
    const entries = yield* fs.readDirectory(binDir)
    for (const entry of entries) {
      if (!expectedBins.has(entry)) {
        yield* fs.remove(path.join(binDir, entry), { recursive: true })
      }
    }
  })

/** Error when install fails */
export class InstallFailedError extends Schema.TaggedError<InstallFailedError>()('InstallFailedError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Install failed: ${this.reason}`
  }
}

/** Error when a package.json file cannot be parsed */
export class PackageJsonParseError extends Schema.TaggedError<PackageJsonParseError>()(
  'PackageJsonParseError',
  {
    path: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to parse package.json at ${this.path}`
  }
}
