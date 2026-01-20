/**
 * Test Fixtures and Setup Utilities
 *
 * Provides helpers for creating test workspaces, git repos, and megarepo configs.
 */

import { Command, FileSystem, Path } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import os from 'node:os'
import { MegarepoConfig, type MemberConfig } from '../lib/config.ts'

// =============================================================================
// Types
// =============================================================================

/** Configuration for a test git repository */
export interface RepoFixture {
  /** Repository name (used as directory name) */
  readonly name: string
  /** Initial files to create (relative path -> content) */
  readonly files?: Record<string, string>
  /** Whether to leave uncommitted changes */
  readonly dirty?: boolean
  /** Remote URL to set (optional) */
  readonly remote?: string
}

/** Configuration for a test megarepo workspace */
export interface WorkspaceFixture {
  /** Name for the workspace directory */
  readonly name?: string
  /** Members to add to megarepo.json */
  readonly members?: Record<string, MemberConfig>
  /** Repos to create and symlink */
  readonly repos?: ReadonlyArray<RepoFixture>
}

/** Result of creating a workspace fixture */
export interface WorkspaceResult {
  /** Path to the workspace directory */
  readonly workspacePath: string
  /** Path to each repo by name */
  readonly repoPaths: Record<string, string>
}

// =============================================================================
// Git Helpers
// =============================================================================

/** Run a git command in a specific directory */
export const runGitCommand = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    const result = yield* Command.string(command)
    return result.trim()
  })

/** Initialize a new git repository */
export const initGitRepo = (path: string) =>
  Effect.gen(function* () {
    yield* runGitCommand(path, 'init')
    yield* runGitCommand(path, 'config', 'user.email', 'test@example.com')
    yield* runGitCommand(path, 'config', 'user.name', 'Test User')
  })

/** Add files and create a commit */
export const addCommit = (repoPath: string, message: string, filename?: string) =>
  Effect.gen(function* () {
    if (filename) {
      yield* runGitCommand(repoPath, 'add', filename)
    } else {
      yield* runGitCommand(repoPath, 'add', '-A')
    }
    yield* runGitCommand(repoPath, 'commit', '--no-verify', '-m', message)
  })

/** Get the current HEAD commit hash */
export const getGitRev = (repoPath: string) => runGitCommand(repoPath, 'rev-parse', 'HEAD')

/** Get the short HEAD commit hash */
export const getGitRevShort = (repoPath: string) => runGitCommand(repoPath, 'rev-parse', '--short', 'HEAD')

// =============================================================================
// Fixture Builders
// =============================================================================

/**
 * Create a bare git repository for testing clone operations.
 * The repo is created in a temp directory and automatically cleaned up.
 */
export const createBareRepo = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const tmpDir = yield* fs.makeTempDirectoryScoped()
    const repoPath = pathService.join(tmpDir, `${name}.git`)

    yield* fs.makeDirectory(repoPath, { recursive: true })
    yield* runGitCommand(repoPath, 'init', '--bare')

    return repoPath
  })

/**
 * Create a git repository with optional initial content.
 */
export const createRepo = (basePath: string, fixture: RepoFixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const repoPath = pathService.join(basePath, fixture.name)
    yield* fs.makeDirectory(repoPath, { recursive: true })

    // Initialize git
    yield* initGitRepo(repoPath)

    // Set remote if provided
    if (fixture.remote) {
      yield* runGitCommand(repoPath, 'remote', 'add', 'origin', fixture.remote)
    }

    // Create initial files
    const files = fixture.files ?? { 'README.md': `# ${fixture.name}\n` }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = pathService.join(repoPath, filePath)
      const dir = pathService.dirname(fullPath)
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(fullPath, content)
    }

    // Initial commit
    yield* addCommit(repoPath, 'Initial commit')

    // Add dirty changes if requested
    if (fixture.dirty) {
      yield* fs.writeFileString(pathService.join(repoPath, 'dirty.txt'), 'uncommitted changes\n')
    }

    return repoPath
  })

/**
 * Create a test megarepo workspace with optional member repos.
 * The workspace is created in a temp directory and automatically cleaned up.
 */
export const createWorkspace = (fixture?: WorkspaceFixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    // Create temp directory
    const tmpDir = yield* fs.makeTempDirectoryScoped()
    const workspaceName = fixture?.name ?? 'test-workspace'
    const workspacePath = pathService.join(tmpDir, workspaceName)

    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: typeof MegarepoConfig.Type = {
      members: fixture?.members ?? {},
    }
    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(config)
    yield* fs.writeFileString(pathService.join(workspacePath, 'megarepo.json'), configContent + '\n')

    // Commit config
    yield* addCommit(workspacePath, 'Initialize megarepo')

    // Create repos and symlinks
    const repoPaths: Record<string, string> = {}
    if (fixture?.repos) {
      // Create a store directory for repos
      const storePath = pathService.join(tmpDir, '.megarepo-store')
      yield* fs.makeDirectory(storePath, { recursive: true })

      for (const repoFixture of fixture.repos) {
        const repoPath = yield* createRepo(storePath, repoFixture)
        repoPaths[repoFixture.name] = repoPath

        // Create symlink in workspace
        const symlinkPath = pathService.join(workspacePath, repoFixture.name)
        yield* fs.symlink(repoPath, symlinkPath)
      }
    }

    return { workspacePath, repoPaths } satisfies WorkspaceResult
  })

/**
 * Create a megarepo store directory with repos.
 */
export const createStore = (repos: ReadonlyArray<RepoFixture>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const tmpDir = yield* fs.makeTempDirectoryScoped()
    const storePath = pathService.join(tmpDir, '.megarepo')

    yield* fs.makeDirectory(storePath, { recursive: true })

    const repoPaths: Record<string, string> = {}
    for (const repoFixture of repos) {
      // Create in github.com/test-owner structure
      const repoDir = pathService.join(storePath, 'github.com', 'test-owner', repoFixture.name)
      const parentDir = pathService.dirname(repoDir)
      yield* fs.makeDirectory(parentDir, { recursive: true })

      const repoPath = yield* createRepo(parentDir, repoFixture)
      repoPaths[repoFixture.name] = repoPath
    }

    return { storePath, repoPaths }
  })

// =============================================================================
// Output Normalization
// =============================================================================

/** Strip ANSI escape codes from output */
export const stripAnsi = (str: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control characters
  str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

/** Normalize output for snapshot testing */
export const normalizeOutput = (output: string, workspaceName?: string): string => {
  let normalized = stripAnsi(output)

  // Replace full git hashes (40 chars)
  normalized = normalized.replace(/[a-f0-9]{40}/g, '<FULL_HASH>')

  // Replace short git hashes (7-8 chars, word boundary)
  normalized = normalized.replace(/\b[a-f0-9]{7,8}\b/g, '<SHORT_HASH>')

  // Replace workspace name if provided
  if (workspaceName) {
    normalized = normalized.replace(new RegExp(workspaceName, 'g'), '<WORKSPACE>')
  }

  // Replace temp directory paths
  normalized = normalized.replace(new RegExp(os.tmpdir(), 'g'), '<TMPDIR>')
  normalized = normalized.replace(/\/var\/folders\/[^\s]+/g, '<TMPDIR>')

  return normalized
}

// =============================================================================
// Config Helpers
// =============================================================================

/** Read the megarepo.json config from a workspace */
export const readConfig = (workspacePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const configPath = pathService.join(workspacePath, 'megarepo.json')
    const content = yield* fs.readFileString(configPath)
    return yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(content)
  })

/** Generate a megarepo.json config object */
export const generateConfig = (members: Record<string, MemberConfig>): typeof MegarepoConfig.Type => ({
  members,
})
