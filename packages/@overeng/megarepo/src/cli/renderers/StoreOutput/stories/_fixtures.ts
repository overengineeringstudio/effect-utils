/**
 * Shared fixtures for StoreOutput stories.
 *
 * @internal
 */

import type {
  StoreState as StoreStateType,
  StoreFetchResult,
  StoreGcResult,
  StoreGcWarning,
  StoreRepo,
  StoreWorktreeStatus,
} from '../mod.ts'

// =============================================================================
// Add Command - State Factories
// =============================================================================

export const createAddState = (opts: {
  status: 'added' | 'already_exists'
  source: string
  ref: string
  commit?: string
  path: string
}): StoreStateType => ({
  _tag: 'Add',
  status: opts.status,
  source: opts.source,
  ref: opts.ref,
  commit: opts.commit,
  path: opts.path,
})

export const createErrorState = (opts: {
  error: string
  message: string
  source?: string
}): StoreStateType => ({
  _tag: 'Error',
  error: opts.error,
  message: opts.message,
  source: opts.source,
})

// =============================================================================
// Fetch Command - Example Data & State Factory
// =============================================================================

export const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

export const createFetchState = (opts: {
  results: StoreFetchResult[]
  elapsedMs: number
}): StoreStateType => ({
  _tag: 'Fetch',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  elapsedMs: opts.elapsedMs,
})

// =============================================================================
// GC Command - Example Data & State Factory
// =============================================================================

export const exampleGcResults: StoreGcResult[] = [
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'feat/old-branch',
    path: '/store/...',
    status: 'removed',
  },
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'main',
    path: '/store/...',
    status: 'skipped_in_use',
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils',
    ref: 'dev',
    path: '/store/...',
    status: 'skipped_dirty',
  },
]

export const createGcState = (opts: {
  results: StoreGcResult[]
  dryRun: boolean
  warning?: StoreGcWarning
  showForceHint: boolean
}): StoreStateType => ({
  _tag: 'Gc',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  dryRun: opts.dryRun,
  warning: opts.warning,
  showForceHint: opts.showForceHint,
})

// =============================================================================
// List Command - Example Data & State Factory
// =============================================================================

export const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/effect-ts/effect' },
  { relativePath: 'github.com/overengineeringstudio/effect-utils' },
  { relativePath: 'github.com/schickling/dotfiles' },
]

export const createLsState = (repos: StoreRepo[]): StoreStateType => ({
  _tag: 'Ls',
  basePath: '/Users/dev/.megarepo',
  repos,
})

// =============================================================================
// Status Command - Example Data & State Factory
// =============================================================================

export const healthyWorktrees: StoreWorktreeStatus[] = [
  {
    repo: 'github.com/effect-ts/effect/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
    issues: [],
  },
]

export const mixedIssuesWorktrees: StoreWorktreeStatus[] = [
  {
    repo: 'github.com/effect-ts/effect/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/livestorejs/livestore/',
    ref: 'dev',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/livestorejs/livestore/refs/heads/dev/',
    issues: [
      {
        type: 'ref_mismatch',
        severity: 'error',
        message: "path says 'dev' but HEAD is 'refactor/genie-igor-ci'",
      },
      { type: 'dirty', severity: 'warning', message: '27 uncommitted changes' },
      { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
    ],
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
    issues: [{ type: 'dirty', severity: 'warning', message: '36 uncommitted changes' }],
  },
  {
    repo: 'github.com/schickling/dotfiles/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/schickling/dotfiles/refs/heads/main/',
    issues: [{ type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' }],
  },
]

export const createStatusState = (opts: {
  repoCount: number
  worktreeCount: number
  diskUsage?: string
  worktrees: StoreWorktreeStatus[]
}): StoreStateType => ({
  _tag: 'Status',
  basePath: '/Users/dev/.megarepo',
  repoCount: opts.repoCount,
  worktreeCount: opts.worktreeCount,
  diskUsage: opts.diskUsage,
  worktrees: opts.worktrees,
})
