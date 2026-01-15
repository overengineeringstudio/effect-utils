/**
 * dotdot status command
 *
 * Shows status of all repos in the workspace using WorkspaceService.
 * Groups links and deps under their declaring members.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { NodeFileSystem } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import {
  CurrentWorkingDirectory,
  isDangling,
  isDiverged,
  isMember,
  type PackageIndexEntry,
  type RepoInfo,
  WorkspaceService,
} from '../lib/mod.ts'
import {
  collectPackageMappings,
  getSymlinkStatus,
  getUniqueMappings,
  type PackageMapping,
} from './link.ts'

/** Format a repo's branch/rev status */
const formatRepoStatus = (repo: RepoInfo): string => {
  const parts: string[] = []

  if (repo.fsState._tag === 'missing') {
    return 'MISSING'
  } else if (repo.fsState._tag === 'not-git') {
    return 'NOT GIT'
  } else if (repo.gitState) {
    parts.push(`${repo.gitState.branch}@${repo.gitState.shortRev}`)

    if (repo.gitState.isDirty) {
      parts.push('*dirty*')
    }

    if (isDiverged(repo)) {
      parts.push(`[diverged from ${repo.pinnedRev?.slice(0, 7)}]`)
    } else if (!repo.pinnedRev) {
      parts.push('[no pin]')
    }
  }

  return parts.join(' ')
}

/** Format status output grouped by member */
const formatStatusGrouped = ({
  workspaceRoot,
  allRepos,
  packages,
  memberConfigs,
}: {
  workspaceRoot: string
  allRepos: RepoInfo[]
  packages: Record<string, PackageIndexEntry>
  memberConfigs: { repoName: string; config: { deps?: Record<string, unknown> | undefined } }[]
}) =>
  Effect.gen(function* () {
    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    if (allRepos.length === 0) {
      yield* Effect.log('No repos found.')
      return
    }

    // Collect package mappings for symlink status
    const mappings = collectPackageMappings({ workspaceRoot, packages })
    const uniqueMappings = getUniqueMappings(mappings)

    // Group packages by source repo
    const packagesByRepo = new Map<string, PackageMapping[]>()
    for (const mapping of uniqueMappings.values()) {
      const existing = packagesByRepo.get(mapping.sourceRepo) ?? []
      existing.push(mapping)
      packagesByRepo.set(mapping.sourceRepo, existing)
    }

    // Get deps by member
    const depsByMember = new Map<string, string[]>()
    for (const memberConfig of memberConfigs) {
      if (memberConfig.config.deps) {
        depsByMember.set(memberConfig.repoName, Object.keys(memberConfig.config.deps))
      }
    }

    // Partition repos
    const members = allRepos.filter(isMember)
    const dependencies = allRepos.filter((r) => r.tracking._tag === 'dependency')
    const dangling = allRepos.filter(isDangling)

    // Track which dependencies have been shown under a member
    const shownDeps = new Set<string>()

    // Show members with their links and deps
    for (const member of members) {
      const status = formatRepoStatus(member)
      yield* Effect.log(`${member.name}: ${status}`)

      // Show links (packages from this repo)
      const repoPackages = packagesByRepo.get(member.name) ?? []
      if (repoPackages.length > 0) {
        yield* Effect.log('  links:')
        for (const pkg of repoPackages) {
          const symlinkStatus = yield* getSymlinkStatus(pkg)
          const relativePath = path.relative(path.join(workspaceRoot, pkg.sourceRepo), pkg.source)
          yield* Effect.log(`    ${pkg.targetName} -> ${relativePath} [${symlinkStatus}]`)
        }
      }

      // Show deps (dependencies declared by this member)
      const memberDeps = depsByMember.get(member.name) ?? []
      if (memberDeps.length > 0) {
        yield* Effect.log('  deps:')
        for (const depName of memberDeps) {
          const depRepo = allRepos.find((r) => r.name === depName)
          if (depRepo) {
            const depRev = depRepo.pinnedRev?.slice(0, 7) ?? 'no pin'
            yield* Effect.log(`    ${depName} @ ${depRev}`)
            shownDeps.add(depName)
          }
        }
      }

      yield* Effect.log('')
    }

    // Show standalone dependencies (not declared by any member but in root config)
    const standaloneDeps = dependencies.filter((d) => !shownDeps.has(d.name))
    if (standaloneDeps.length > 0) {
      for (const dep of standaloneDeps) {
        const status = formatRepoStatus(dep)
        yield* Effect.log(`${dep.name}: ${status} (dependency)`)
      }
      yield* Effect.log('')
    }

    // Show dangling repos
    if (dangling.length > 0) {
      yield* Effect.log(`Dangling (${dangling.length}):`)
      for (const repo of dangling) {
        const status = formatRepoStatus(repo)
        yield* Effect.log(`  ${repo.name}: ${status}`)
      }
      yield* Effect.log('')
    }

    // Summary
    const total = members.length + dependencies.length + dangling.length
    yield* Effect.log(`Total: ${members.length} member(s), ${dependencies.length} dep(s)${dangling.length > 0 ? `, ${dangling.length} dangling` : ''} — ${total} repo(s)`)
  })

/** Status command handler - separated for testability */
export const statusHandler = Effect.gen(function* () {
  const workspace = yield* WorkspaceService

  // Scan all repos
  const allRepos = yield* workspace.scanRepos()

  // Get packages from root config
  const packages = workspace.rootConfig.config.packages ?? {}

  // Format and output
  yield* formatStatusGrouped({
    workspaceRoot: workspace.root,
    allRepos,
    packages,
    memberConfigs: workspace.memberConfigs,
  })
}).pipe(Effect.withSpan('dotdot/status'))

/** Status command implementation */
export const statusCommand = Cli.Command.make('status', {}, () =>
  statusHandler.pipe(
    Effect.provide(
      WorkspaceService.live.pipe(
        Layer.provide(CurrentWorkingDirectory.live),
        Layer.provide(NodeFileSystem.layer),
      ),
    ),
    Effect.catchTag('ConfigOutOfSyncError', (e) => Effect.logError(e.message)),
  ),
)
