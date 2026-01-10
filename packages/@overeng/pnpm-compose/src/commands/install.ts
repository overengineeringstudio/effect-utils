import * as Cli from '@effect/cli'
import { Command, FileSystem, Path } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

import { findCatalogConflicts, readRepoCatalog } from '../catalog.ts'
import { detectComposedRepos } from '../config.ts'
import {
  findAllSubmodules,
  findDuplicates,
  pickCanonicalSubmodule,
  updateSubmoduleWithSymlink,
} from '../submodule-dedupe.ts'

/** Install command: runs the linking dance for composed repos */
export const installCommand = Cli.Command.make(
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
      if (wrongSymlinks.length === 0 && !clean) {
        yield* Console.log('✓ Symlinks already correct, skipping install')
        return
      }

      // Case 3: Full install dance (no node_modules or --clean)
      if (!nodeModulesExists || clean) {
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

        yield* Console.log('✓ Install complete')
        return
      }

      // Case 2: Incremental fix (node_modules exists, some symlinks wrong)
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
          catch: () => new Error(`Failed to parse ${pkgJsonPath}`),
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

/** Error when install fails */
class InstallFailedError extends Schema.TaggedError<InstallFailedError>()('InstallFailedError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Install failed: ${this.reason}`
  }
}
