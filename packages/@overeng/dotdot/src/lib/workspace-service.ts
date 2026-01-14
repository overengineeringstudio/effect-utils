/**
 * WorkspaceService - Central service for workspace operations
 *
 * Provides unified view of all repos in a workspace with their tracking status,
 * filesystem state, and git information.
 */

import path from 'node:path'

import { type CommandExecutor, FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Context, Effect, Layer } from 'effect'

import { type RepoConfig, type MemberConfig } from './config.ts'
import * as Git from './git.ts'
import {
  collectMemberConfigs,
  findWorkspaceRoot,
  loadRootConfig,
  loadRootConfigWithSyncCheck,
  mergeMemberConfigs,
  type MemberConfigSource,
  type RootConfigSource,
} from './loader.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

// =============================================================================
// Unified Repo Model
// =============================================================================

/** How a repo is tracked in the workspace */
export type RepoTracking =
  | { _tag: 'member'; config: MemberConfig }
  | { _tag: 'dependency'; declaredBy: string[]; config: RepoConfig }
  | { _tag: 'dangling' }

/** Filesystem state of a repo */
export type RepoFsState = { _tag: 'missing' } | { _tag: 'not-git' } | { _tag: 'exists' }

/** Git state of a repo (when it exists as a git repo) */
export type RepoGitState = {
  rev: string
  shortRev: string
  branch: string
  isDirty: boolean
  remoteUrl: string | undefined
}

/** Unified repo information combining tracking, fs, and git state */
export type RepoInfo = {
  name: string
  /** Absolute path to the repo directory */
  path: string
  /** How this repo is tracked in the workspace */
  tracking: RepoTracking
  /** Filesystem state */
  fsState: RepoFsState
  /** Git state (only present if fsState is 'exists') */
  gitState: RepoGitState | undefined
  /** Pinned revision from config (if tracked as member or dependency) */
  pinnedRev: string | undefined
}

/** Check if repo is a member (has dotdot.json) */
export const isMember = (repo: RepoInfo): boolean => repo.tracking._tag === 'member'

/** Check if repo is a dependency */
export const isDependency = (repo: RepoInfo): boolean => repo.tracking._tag === 'dependency'

/** Check if repo is dangling (exists but not tracked) */
export const isDangling = (repo: RepoInfo): boolean => repo.tracking._tag === 'dangling'

/** Check if repo exists on filesystem as a git repo */
export const existsAsGitRepo = (repo: RepoInfo): boolean => repo.fsState._tag === 'exists'

/** Check if repo is diverged from its pinned revision */
export const isDiverged = (repo: RepoInfo): boolean => {
  if (!repo.pinnedRev || !repo.gitState) return false
  return !repo.gitState.rev.startsWith(repo.pinnedRev) && repo.gitState.rev !== repo.pinnedRev
}

// =============================================================================
// WorkspaceService
// =============================================================================

/** Workspace context with root path and config */
export type WorkspaceContext = {
  /** Absolute path to workspace root */
  root: string
  /** Root config source */
  rootConfig: RootConfigSource
  /** Member config sources */
  memberConfigs: MemberConfigSource[]
}

/** Error type for workspace scanning operations */
export type WorkspaceScanError = PlatformError | Git.GitError

/** Dependencies required for workspace scanning */
export type WorkspaceScanDeps = FileSystem.FileSystem | CommandExecutor.CommandExecutor

/** WorkspaceService interface */
export type WorkspaceServiceApi = {
  /** Workspace root path */
  readonly root: string
  /** Get all repos with unified info */
  readonly scanRepos: () => Effect.Effect<RepoInfo[], WorkspaceScanError, WorkspaceScanDeps>
  /** Get only member repos (have dotdot.json) */
  readonly getMembers: () => Effect.Effect<RepoInfo[], WorkspaceScanError, WorkspaceScanDeps>
  /** Get only dependency repos */
  readonly getDependencies: () => Effect.Effect<RepoInfo[], WorkspaceScanError, WorkspaceScanDeps>
  /** Get only dangling repos (exist but not tracked) */
  readonly getDangling: () => Effect.Effect<RepoInfo[], WorkspaceScanError, WorkspaceScanDeps>
  /** Get repo info by name */
  readonly getRepo: (
    name: string,
  ) => Effect.Effect<RepoInfo | undefined, WorkspaceScanError, WorkspaceScanDeps>
  /** Root config */
  readonly rootConfig: RootConfigSource
  /** Member configs */
  readonly memberConfigs: MemberConfigSource[]
}

/** WorkspaceService - provides unified view of workspace repos */
export class WorkspaceService extends Context.Tag('dotdot/WorkspaceService')<
  WorkspaceService,
  WorkspaceServiceApi
>() {
  /** Create from workspace context */
  static fromContext = (ctx: WorkspaceContext): WorkspaceServiceApi => {
    const merged = mergeMemberConfigs(ctx.memberConfigs)

    // Build tracking info for each repo
    const buildTracking = (name: string): RepoTracking => {
      // Check if it's a member (has dotdot.json)
      const memberSource = ctx.memberConfigs.find((m) => m.repoName === name)
      if (memberSource) {
        return { _tag: 'member', config: memberSource.config }
      }

      // Check if it's a declared dependency
      if (merged.declaredDeps.has(name)) {
        const config = merged.repos[name]
        if (config) {
          // Find which members declare this as a dependency
          const declaredBy = ctx.memberConfigs
            .filter((m) => m.config.deps && name in m.config.deps)
            .map((m) => m.repoName)
          return { _tag: 'dependency', declaredBy, config }
        }
      }

      // Check if it's in root config but not a member or declared dep
      const rootRepoConfig = ctx.rootConfig.config.repos[name]
      if (rootRepoConfig) {
        return { _tag: 'dependency', declaredBy: [], config: rootRepoConfig }
      }

      return { _tag: 'dangling' }
    }

    // Get pinned rev for a repo
    const getPinnedRev = ({
      name,
      tracking,
    }: {
      name: string
      tracking: RepoTracking
    }): string | undefined => {
      if (tracking._tag === 'dependency') {
        return tracking.config.rev
      }
      // Members get their pinned rev from root config
      const rootConfig = ctx.rootConfig.config.repos[name]
      return rootConfig?.rev
    }

    // Get git state for a repo
    const getGitState = (repoPath: string) =>
      Effect.gen(function* () {
        const rev = yield* Git.getCurrentRev(repoPath)
        const shortRev = yield* Git.getShortRev(repoPath)
        const branch = yield* Git.getCurrentBranch(repoPath)
        const isDirty = yield* Git.isDirty(repoPath)
        const remoteUrl = yield* Git.getRemoteUrl(repoPath).pipe(
          Effect.map((url) => url || undefined),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        return { rev, shortRev, branch, isDirty, remoteUrl } satisfies RepoGitState
      })

    // Get fs state for a repo
    const getFsState = (repoPath: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const exists = yield* fs.exists(repoPath)
        if (!exists) return { _tag: 'missing' } as const

        const isGitRepo = yield* Git.isGitRepo(repoPath)
        if (!isGitRepo) return { _tag: 'not-git' } as const

        return { _tag: 'exists' } as const
      })

    // Get repo info for a single repo
    const getRepoInfo = (name: string) =>
      Effect.gen(function* () {
        const repoPath = path.join(ctx.root, name)
        const tracking = buildTracking(name)
        const fsState = yield* getFsState(repoPath)
        const pinnedRev = getPinnedRev({ name, tracking })

        const gitState = fsState._tag === 'exists' ? yield* getGitState(repoPath) : undefined

        return {
          name,
          path: repoPath,
          tracking,
          fsState,
          gitState,
          pinnedRev,
        } satisfies RepoInfo
      })

    // Scan all repos in workspace
    const scanRepos = () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        // Collect all known repo names
        const knownNames = new Set<string>([
          ...merged.membersWithConfig,
          ...merged.declaredDeps,
          ...Object.keys(ctx.rootConfig.config.repos),
        ])

        // Scan filesystem for additional git repos (dangling)
        const entries = yield* fs.readDirectory(ctx.root)
        for (const entry of entries) {
          if (entry.startsWith('.')) continue
          const entryPath = path.join(ctx.root, entry)
          const stat = yield* fs.stat(entryPath)
          if (stat.type !== 'Directory') continue

          const isGitRepo = yield* Git.isGitRepo(entryPath)
          if (isGitRepo) {
            knownNames.add(entry)
          }
        }

        // Get info for all repos
        const repos = yield* Effect.all(Array.from(knownNames).map(getRepoInfo), {
          concurrency: 'unbounded',
        })

        return repos
      })

    const getRepo = (name: string) =>
      Effect.gen(function* () {
        const repos = yield* scanRepos()
        return repos.find((r) => r.name === name)
      })

    const getMembers = () =>
      Effect.gen(function* () {
        const repos = yield* scanRepos()
        return repos.filter(isMember)
      })

    const getDependencies = () =>
      Effect.gen(function* () {
        const repos = yield* scanRepos()
        return repos.filter(isDependency)
      })

    const getDangling = () =>
      Effect.gen(function* () {
        const repos = yield* scanRepos()
        return repos.filter(isDangling)
      })

    return {
      root: ctx.root,
      rootConfig: ctx.rootConfig,
      memberConfigs: ctx.memberConfigs,
      scanRepos,
      getRepo,
      getMembers,
      getDependencies,
      getDangling,
    }
  }

  /**
   * Layer that loads workspace from CWD with sync check.
   *
   * IMPORTANT: This layer validates that all member configs are in sync with
   * the root config during construction. Commands that require config to be
   * in sync should use this layer. Commands like `sync` that need to run when
   * config is OUT of sync should use `liveNoSyncCheck` instead.
   *
   * Each command provides its own WorkspaceService layer rather than having
   * a global layer in the CLI. This allows commands like `sync` to work when
   * config is out of sync, while other commands can validate sync status.
   */
  static live = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory
      const root = yield* findWorkspaceRoot(cwd)
      const rootConfig = yield* loadRootConfigWithSyncCheck(root)
      const memberConfigs = yield* collectMemberConfigs(root)
      return WorkspaceService.fromContext({ root, rootConfig, memberConfigs })
    }),
  )

  /** Layer that loads workspace from CWD without sync check.
   * Use this for commands that need to run even when config is out of sync (e.g. sync). */
  static liveNoSyncCheck = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory
      const root = yield* findWorkspaceRoot(cwd)
      const rootConfig = yield* loadRootConfig(root)
      const memberConfigs = yield* collectMemberConfigs(root)
      return WorkspaceService.fromContext({ root, rootConfig, memberConfigs })
    }),
  )

  /** Layer from explicit workspace root with sync check */
  static fromRoot = (root: string) =>
    Layer.effect(
      WorkspaceService,
      Effect.gen(function* () {
        const rootConfig = yield* loadRootConfigWithSyncCheck(root)
        const memberConfigs = yield* collectMemberConfigs(root)
        return WorkspaceService.fromContext({ root, rootConfig, memberConfigs })
      }),
    )

  /** Layer from explicit workspace root without sync check */
  static fromRootNoSyncCheck = (root: string) =>
    Layer.effect(
      WorkspaceService,
      Effect.gen(function* () {
        const rootConfig = yield* loadRootConfig(root)
        const memberConfigs = yield* collectMemberConfigs(root)
        return WorkspaceService.fromContext({ root, rootConfig, memberConfigs })
      }),
    )
}
