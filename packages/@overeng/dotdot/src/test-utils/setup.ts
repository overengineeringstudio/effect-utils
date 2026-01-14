/**
 * Test fixtures setup for dotdot
 *
 * Creates temporary directories with git repos and config files for testing.
 * Uses Effect FileSystem for all file operations.
 */

import { Command, FileSystem } from '@effect/platform'
import { Effect, pipe } from 'effect'

export type RepoFixture = {
  name: string
  /** Create as git repo */
  isGitRepo?: boolean
  /** Create with dirty working tree */
  isDirty?: boolean
  /** Has its own dotdot.json member config */
  hasConfig?: boolean
  /** Member config deps (repos this one depends on) */
  configDeps?: Record<string, { url: string; rev?: string }>
  /** Member config exposes (packages this repo provides) */
  configExposes?: Record<string, { path: string; install?: string }>
  /** Git remote URL to set (for testing workspace member detection) */
  remoteUrl?: string
}

export type WorkspaceFixture = {
  /** Root config repos */
  rootRepos?: Record<string, { url: string; rev?: string }>
  /** Peer repos to create */
  repos: RepoFixture[]
}

/** Create a temporary workspace for testing - returns Effect that yields workspace path */
export const createWorkspace = (fixture: WorkspaceFixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = yield* fs.makeTempDirectoryScoped()

    // Create root config at workspace root
    if (fixture.rootRepos && Object.keys(fixture.rootRepos).length > 0) {
      const configContent = generateConfig(fixture.rootRepos)
      yield* fs.writeFileString(`${tmpDir}/dotdot-root.json`, configContent)
    } else {
      const emptyConfig = JSON.stringify({ repos: {} }, null, 2) + '\n'
      yield* fs.writeFileString(`${tmpDir}/dotdot-root.json`, emptyConfig)
    }

    // Create repos
    for (const repo of fixture.repos) {
      const repoPath = `${tmpDir}/${repo.name}`
      yield* fs.makeDirectory(repoPath, { recursive: true })

      if (repo.isGitRepo !== false) {
        // Initialize git repo
        yield* runGitCommand(['init'], repoPath)
        yield* runGitCommand(['config', 'user.email', 'test@test.com'], repoPath)
        yield* runGitCommand(['config', 'user.name', 'Test'], repoPath)

        // Create initial commit
        yield* fs.writeFileString(`${repoPath}/README.md`, `# ${repo.name}\n`)
        yield* runGitCommand(['add', '.'], repoPath)
        yield* runGitCommand(['commit', '--no-verify', '-m', 'Initial commit'], repoPath)

        if (repo.isDirty) {
          yield* fs.writeFileString(`${repoPath}/dirty.txt`, 'dirty\n')
        }

        if (repo.remoteUrl) {
          yield* runGitCommand(['remote', 'add', 'origin', repo.remoteUrl], repoPath)
        }
      }

      if (repo.hasConfig) {
        const configContent = generateMemberConfig(repo.configExposes, repo.configDeps)
        yield* fs.writeFileString(`${repoPath}/dotdot.json`, configContent)
      }
    }

    return tmpDir
  })

/** Run a git command in a directory */
const runGitCommand = (args: readonly string[], cwd: string) =>
  pipe(Command.make('git', ...args), Command.workingDirectory(cwd), Command.exitCode, Effect.asVoid)

/** Generate JSON config file content */
const generateConfig = (repos: Record<string, { url: string; rev?: string }>): string => {
  const reposObj: Record<string, { url: string; rev?: string }> = {}
  for (const [name, config] of Object.entries(repos)) {
    reposObj[name] = { url: config.url }
    if (config.rev) {
      reposObj[name].rev = config.rev
    }
  }
  return JSON.stringify({ repos: reposObj }, null, 2) + '\n'
}

/** Get the current git rev of a repo */
export const getGitRev = (repoPath: string) =>
  pipe(
    Command.make('git', 'rev-parse', 'HEAD'),
    Command.workingDirectory(repoPath),
    Command.string,
    Effect.map((s) => s.trim()),
  )

/** Create a bare git repository (for clone tests) */
export const createBareRepo = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const tmpDir = yield* fs.makeTempDirectoryScoped()
    const repoPath = `${tmpDir}/${name}.git`

    // Create bare repo
    yield* fs.makeDirectory(repoPath)
    yield* runGitCommand(['init', '--bare'], repoPath)

    // Create a temp repo, add commit, push to bare
    const tempRepoPath = `${tmpDir}/temp-repo`
    yield* fs.makeDirectory(tempRepoPath)
    yield* runGitCommand(['init'], tempRepoPath)
    yield* runGitCommand(['config', 'user.email', 'test@test.com'], tempRepoPath)
    yield* runGitCommand(['config', 'user.name', 'Test'], tempRepoPath)
    yield* fs.writeFileString(`${tempRepoPath}/README.md`, `# ${name}\n`)
    yield* runGitCommand(['add', '.'], tempRepoPath)
    yield* runGitCommand(['commit', '--no-verify', '-m', 'Initial commit'], tempRepoPath)
    yield* runGitCommand(['push', repoPath, 'HEAD:main'], tempRepoPath)

    // Clean up temp repo
    yield* fs.remove(tempRepoPath, { recursive: true })

    return repoPath
  })

/** Add a commit to a repo */
export const addCommit = (repoPath: string, message: string, filename?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = filename ?? `file-${Date.now()}.txt`
    yield* fs.writeFileString(`${repoPath}/${file}`, `${message}\n`)
    yield* runGitCommand(['add', '.'], repoPath)
    yield* runGitCommand(['commit', '--no-verify', '-m', message], repoPath)
    return yield* getGitRev(repoPath)
  })

/** Read the root config file content */
export const readConfig = (workspacePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(`${workspacePath}/dotdot-root.json`)
  })

/** Create package target directory with files */
export const createPackageTarget = (repoPath: string, packagePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetPath = `${repoPath}/${packagePath}`
    yield* fs.makeDirectory(targetPath, { recursive: true })
    yield* fs.writeFileString(`${targetPath}/package.json`, '{"name": "test-package"}\n')
  })

type PackageIndexEntry = { repo: string; path: string; install?: string }

/** Generate root config JSON with repos and packages index */
export const generateRootConfig = (
  repos: Record<string, { url: string; rev?: string; install?: string }>,
  packages?: Record<string, PackageIndexEntry>,
): string => {
  const output: {
    repos: Record<string, { url: string; rev?: string; install?: string }>
    packages?: Record<string, PackageIndexEntry>
  } = { repos }

  if (packages && Object.keys(packages).length > 0) {
    output.packages = packages
  }

  return JSON.stringify(output, null, 2) + '\n'
}

/** Generate member config JSON with exposes and deps */
export const generateMemberConfig = (
  exposes?: Record<string, { path: string; install?: string }>,
  deps?: Record<string, { url: string; rev?: string }>,
): string => {
  const output: {
    exposes?: Record<string, { path: string; install?: string }>
    deps?: Record<string, { url: string; rev?: string }>
  } = {}

  if (exposes && Object.keys(exposes).length > 0) {
    output.exposes = exposes
  }
  if (deps && Object.keys(deps).length > 0) {
    output.deps = deps
  }

  return JSON.stringify(output, null, 2) + '\n'
}
