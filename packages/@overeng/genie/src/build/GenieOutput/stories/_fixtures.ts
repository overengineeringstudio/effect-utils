/**
 * Shared fixtures for GenieOutput stories.
 *
 * @internal
 */

import type {
  GenieAction,
  GenieFile,
  GenieFileStatus,
  GenieMode,
  GenieState,
} from '../../../core/schema.ts'

// =============================================================================
// Example Data
// =============================================================================

export const sampleFiles: Array<Pick<GenieFile, 'path' | 'relativePath'>> = [
  { path: '/workspace/packages/foo/package.json', relativePath: 'packages/foo/package.json' },
  { path: '/workspace/packages/foo/tsconfig.json', relativePath: 'packages/foo/tsconfig.json' },
  { path: '/workspace/packages/bar/package.json', relativePath: 'packages/bar/package.json' },
  { path: '/workspace/.github/workflows/ci.yml', relativePath: '.github/workflows/ci.yml' },
  { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
]

/** Common error messages for testing */
export const errorMessages = {
  syntaxError: 'Failed to import: SyntaxError in source file',
  tdzCascade: 'TDZ: Cannot access catalog before initialization',
  fileOutOfDate: 'File is out of date',
  parentMissing: 'Parent directory missing',
  networkTimeout: 'Network timeout while fetching template',
  permissionDenied: 'Permission denied: cannot write to file',
}

// =============================================================================
// State Factories
// =============================================================================

/**
 * Base state factory with sensible defaults.
 */
export const createState = (overrides: Partial<GenieState> = {}): GenieState => ({
  phase: 'complete',
  mode: 'generate',
  cwd: '/workspace',
  files: [],
  ...overrides,
})

/**
 * Mixed results - created, updated, unchanged files.
 */
export const createMixedResultsState = (): GenieState =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 42,
      },
      {
        path: '/workspace/packages/foo/tsconfig.json',
        relativePath: 'packages/foo/tsconfig.json',
        status: 'updated',
        linesAdded: 5,
        linesRemoved: 3,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'unchanged',
      },
      {
        path: '/workspace/.github/workflows/ci.yml',
        relativePath: '.github/workflows/ci.yml',
        status: 'updated',
        linesAdded: 12,
        linesRemoved: 8,
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 2, unchanged: 2, skipped: 0, failed: 0 },
  })

/**
 * All files unchanged - typical re-run scenario.
 */
export const createAllUnchangedState = (): GenieState =>
  createState({
    files: sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
    summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
  })

/**
 * State with file-level errors including TDZ cascade.
 */
export const createWithErrorsState = (): GenieState =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 38,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'error',
        message: errorMessages.syntaxError,
      },
      {
        path: '/workspace/packages/baz/package.json',
        relativePath: 'packages/baz/package.json',
        status: 'error',
        message: errorMessages.tdzCascade,
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 0, unchanged: 1, skipped: 0, failed: 2 },
  })

/**
 * Dry run mode - shows what would be changed.
 */
export const createDryRunState = (): GenieState =>
  createState({
    mode: 'dry-run',
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 35,
      },
      {
        path: '/workspace/packages/foo/tsconfig.json',
        relativePath: 'packages/foo/tsconfig.json',
        status: 'updated',
        linesAdded: 8,
        linesRemoved: 3,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 1, unchanged: 1, skipped: 0, failed: 0 },
  })

/**
 * Check mode - all files up to date (success).
 */
export const createCheckModeState = (): GenieState =>
  createState({
    mode: 'check',
    files: sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
    summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
  })

/**
 * Check mode - some files out of date (failure).
 */
export const createCheckModeFailedState = (): GenieState =>
  createState({
    mode: 'check',
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'unchanged',
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'error',
        message: errorMessages.fileOutOfDate,
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 0, updated: 0, unchanged: 2, skipped: 0, failed: 1 },
  })

/**
 * With skipped files due to missing dependencies.
 */
export const createWithSkippedState = (): GenieState =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
      },
      {
        path: '/workspace/packages/orphan/package.json',
        relativePath: 'packages/orphan/package.json',
        status: 'skipped',
        message: errorMessages.parentMissing,
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 0, unchanged: 1, skipped: 1, failed: 0 },
  })

/**
 * Global error state - for phase='error' scenarios (e.g., config file not found).
 */
export const createGlobalErrorState = (): GenieState =>
  createState({
    phase: 'error',
    error: 'Failed to load genie configuration: genie.config.ts not found in workspace root',
    files: [],
  })

/**
 * Validation failed state - for phase='error' when genie validation finds issues.
 * Error message format matches real `formatValidationIssues()` output.
 */
export const createValidationFailedState = (overrides: { mode?: GenieMode } = {}): GenieState =>
  createState({
    phase: 'error',
    mode: overrides.mode ?? 'check',
    error: `Genie validation failed:
\n@overeng/megarepo:
  ⚠ Missing tsconfig reference "../effect-path" for workspace dependency "@overeng/effect-path"
  ⚠ Missing tsconfig reference "../utils" for workspace dependency "@overeng/utils"
\n@overeng/genie:
  ⚠ Missing tsconfig reference "../tui-react" for workspace dependency "@overeng/tui-react"
  ✗ Missing peer dep "effect" (required by "@overeng/utils")`,
    files: [],
  })

/**
 * Mixed error types - combination of errors + skipped + success.
 */
export const createMixedErrorTypesState = (): GenieState =>
  createState({
    files: [
      {
        path: '/workspace/packages/api/package.json',
        relativePath: 'packages/api/package.json',
        status: 'created',
        linesAdded: 45,
      },
      {
        path: '/workspace/packages/core/package.json',
        relativePath: 'packages/core/package.json',
        status: 'updated',
        linesAdded: 12,
        linesRemoved: 5,
      },
      {
        path: '/workspace/packages/auth/package.json',
        relativePath: 'packages/auth/package.json',
        status: 'error',
        message: errorMessages.syntaxError,
      },
      {
        path: '/workspace/packages/payments/tsconfig.json',
        relativePath: 'packages/payments/tsconfig.json',
        status: 'error',
        message: errorMessages.tdzCascade,
      },
      {
        path: '/workspace/packages/orphan/package.json',
        relativePath: 'packages/orphan/package.json',
        status: 'skipped',
        message: errorMessages.parentMissing,
      },
      {
        path: '/workspace/packages/config/package.json',
        relativePath: 'packages/config/package.json',
        status: 'unchanged',
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 1, unchanged: 2, skipped: 1, failed: 2 },
  })

/**
 * Generate many files for viewport overflow testing.
 */
export const createManyFilesState = (phase: 'generating' | 'complete'): GenieState => {
  const packages = [
    'api',
    'auth',
    'cache',
    'config',
    'core',
    'crypto',
    'database',
    'email',
    'events',
    'files',
    'gateway',
    'http',
    'i18n',
    'jobs',
    'kafka',
    'logger',
    'metrics',
    'notifications',
    'oauth',
    'payments',
    'queue',
    'redis',
    'search',
    'sessions',
    'storage',
    'telemetry',
    'uploads',
    'validation',
    'websocket',
    'workers',
  ]

  const fileTypes = ['package.json', 'tsconfig.json', 'index.ts']

  const files: GenieFile[] = []

  // Generate files for each package
  for (const pkg of packages) {
    for (const fileType of fileTypes) {
      const path = `/workspace/packages/${pkg}/${fileType}`
      const relativePath = `packages/${pkg}/${fileType}`

      // Assign varied statuses to make it interesting
      let status: GenieFile['status']
      let message: string | undefined
      let linesAdded: number | undefined
      let linesRemoved: number | undefined

      if (pkg === 'auth' && fileType === 'package.json') {
        status = 'error'
        message = errorMessages.syntaxError
      } else if (pkg === 'payments' && fileType === 'tsconfig.json') {
        status = 'error'
        message = errorMessages.tdzCascade
      } else if (pkg === 'gateway' && fileType === 'index.ts') {
        status = phase === 'generating' ? 'active' : 'updated'
        linesAdded = 45
        linesRemoved = 12
      } else if (pkg === 'websocket' && fileType === 'package.json') {
        status = phase === 'generating' ? 'active' : 'created'
        linesAdded = 38
      } else if (pkg === 'redis' && fileType === 'index.ts') {
        status = phase === 'generating' ? 'active' : 'updated'
        linesAdded = 23
        linesRemoved = 5
      } else if (['api', 'core', 'http'].includes(pkg)) {
        status = 'created'
        linesAdded = 20 + (pkg.charCodeAt(0) % 30) // Deterministic based on package name
      } else if (['cache', 'config', 'logger'].includes(pkg)) {
        status = 'updated'
        linesAdded = 10 + (pkg.charCodeAt(0) % 15)
        linesRemoved = 3 + (pkg.charCodeAt(0) % 8)
      } else if (pkg === 'i18n') {
        status = 'skipped'
        message = errorMessages.parentMissing
      } else if (phase === 'generating' && ['telemetry', 'workers', 'validation'].includes(pkg)) {
        status = 'pending'
      } else {
        status = 'unchanged'
      }

      files.push({ path, relativePath, status, message, linesAdded, linesRemoved })
    }
  }

  // Calculate summary
  const summary = {
    created: files.filter((f) => f.status === 'created').length,
    updated: files.filter((f) => f.status === 'updated').length,
    unchanged: files.filter((f) => f.status === 'unchanged').length,
    skipped: files.filter((f) => f.status === 'skipped').length,
    failed: files.filter((f) => f.status === 'error').length,
  }

  return createState({
    phase,
    files,
    summary: phase === 'complete' ? summary : undefined,
  })
}

// =============================================================================
// Timeline Factory for Animated Stories
// =============================================================================

export interface FileResult {
  path: string
  status: GenieFileStatus
  message?: string
  linesAdded?: number
  linesRemoved?: number
}

export interface TimelineConfig {
  /** Files to process (defaults to sampleFiles) */
  files?: Array<Pick<GenieFile, 'path' | 'relativePath'>>
  /** Final results for each file */
  results?: FileResult[]
  /** Operation mode */
  mode?: GenieMode
  /** Duration between steps in ms */
  stepDuration?: number
}

/**
 * Creates a timeline that animates through discovering and processing each file.
 * Works like SyncOutput's createTimeline - takes final state config and generates
 * progressive animation using GenieAction types.
 */
export const createTimeline = (
  config: TimelineConfig = {},
): Array<{ at: number; action: GenieAction }> => {
  const files = config.files ?? sampleFiles
  const results: FileResult[] =
    config.results ??
    files.map((f) => ({
      path: f.path,
      status: 'unchanged' as const,
    }))
  const stepDuration = config.stepDuration ?? 300

  if (files.length === 0) {
    // No files - just show complete state
    return [
      {
        at: 0,
        action: {
          _tag: 'Complete',
          summary: { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
        },
      },
    ]
  }

  const timeline: Array<{ at: number; action: GenieAction }> = []
  let currentTime = 0

  // Step 1: Files discovered
  timeline.push({
    at: currentTime,
    action: {
      _tag: 'FilesDiscovered',
      files: files.map((f) => ({ path: f.path, relativePath: f.relativePath })),
    },
  })
  currentTime += stepDuration

  // Step 2: Process each file (start + complete)
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    const result = results.find((r) => r.path === file.path) ?? {
      path: file.path,
      status: 'unchanged' as const,
    }

    // FileStarted
    timeline.push({
      at: currentTime,
      action: { _tag: 'FileStarted', path: file.path },
    })
    currentTime += stepDuration

    // FileCompleted
    timeline.push({
      at: currentTime,
      action: {
        _tag: 'FileCompleted',
        path: file.path,
        status: result.status,
        message: result.message,
        linesAdded: result.linesAdded,
        linesRemoved: result.linesRemoved,
      },
    })
    currentTime += stepDuration / 2 // Shorter gap before next file
  }

  // Step 3: Complete with summary
  const summary = {
    created: results.filter((r) => r.status === 'created').length,
    updated: results.filter((r) => r.status === 'updated').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'error').length,
  }

  currentTime += stepDuration / 2
  timeline.push({
    at: currentTime,
    action: { _tag: 'Complete', summary },
  })

  return timeline
}

/**
 * Pre-built timeline for the demo story - matches createMixedResultsState output.
 */
export const demoTimeline = createTimeline({
  files: sampleFiles,
  results: [
    { path: sampleFiles[0]!.path, status: 'created', linesAdded: 42 },
    { path: sampleFiles[1]!.path, status: 'updated', linesAdded: 5, linesRemoved: 3 },
    { path: sampleFiles[2]!.path, status: 'unchanged' },
    { path: sampleFiles[3]!.path, status: 'updated', linesAdded: 12, linesRemoved: 8 },
    { path: sampleFiles[4]!.path, status: 'unchanged' },
  ],
  stepDuration: 400,
})

/**
 * Timeline with errors - demonstrates error handling during generation.
 */
export const errorTimeline = createTimeline({
  files: [
    { path: '/workspace/packages/foo/package.json', relativePath: 'packages/foo/package.json' },
    { path: '/workspace/packages/bar/package.json', relativePath: 'packages/bar/package.json' },
    { path: '/workspace/packages/baz/package.json', relativePath: 'packages/baz/package.json' },
    { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
  ],
  results: [
    { path: '/workspace/packages/foo/package.json', status: 'created', linesAdded: 38 },
    {
      path: '/workspace/packages/bar/package.json',
      status: 'error',
      message: errorMessages.syntaxError,
    },
    {
      path: '/workspace/packages/baz/package.json',
      status: 'error',
      message: errorMessages.tdzCascade,
    },
    { path: '/workspace/tsconfig.base.json', status: 'unchanged' },
  ],
  stepDuration: 500,
})
