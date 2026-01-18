/**
 * Test fixtures setup for dotdot
 *
 * Creates temporary directories with git repos and config files for testing.
 * Uses Effect FileSystem for all file operations.
 */

import { Command, FileSystem } from '@effect/platform'
import { Effect, pipe } from 'effect'

/** Test fixture specification for a repository */
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

/** Test fixture specification for a workspace */
export type WorkspaceFixture = {
  /** Root config repos */
  rootRepos?: Record<string, { url: string; rev?: string }>
  /** Peer repos to create */
  repos: RepoFixture[]
}

/** Create a temporary workspace for testing - returns Effect that yields workspace path */
export const createWorkspace = Effect.fnUntraced(function* (fixture: WorkspaceFixture) {
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
      yield* runGitCommand({ args: ['init'], cwd: repoPath })
      yield* runGitCommand({ args: ['config', 'user.email', 'test@test.com'], cwd: repoPath })
      yield* runGitCommand({ args: ['config', 'user.name', 'Test'], cwd: repoPath })

      // Create initial commit
      yield* fs.writeFileString(`${repoPath}/README.md`, `# ${repo.name}\n`)
      yield* runGitCommand({ args: ['add', '.'], cwd: repoPath })
      yield* runGitCommand({
        args: ['commit', '--no-verify', '-m', 'Initial commit'],
        cwd: repoPath,
      })

      if (repo.isDirty) {
        yield* fs.writeFileString(`${repoPath}/dirty.txt`, 'dirty\n')
      }

      if (repo.remoteUrl) {
        yield* runGitCommand({ args: ['remote', 'add', 'origin', repo.remoteUrl], cwd: repoPath })
      }
    }

    if (repo.hasConfig) {
      const configContent = generateMemberConfig({
        ...(repo.configExposes !== undefined && { exposes: repo.configExposes }),
        ...(repo.configDeps !== undefined && { deps: repo.configDeps }),
      })
      yield* fs.writeFileString(`${repoPath}/dotdot.json`, configContent)
    }
  }

  return tmpDir
})

/** Run a git command in a directory */
const runGitCommand = ({ args, cwd }: { args: readonly string[]; cwd: string }) =>
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
export const createBareRepo = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem

  const tmpDir = yield* fs.makeTempDirectoryScoped()
  const repoPath = `${tmpDir}/${name}.git`

  // Create bare repo
  yield* fs.makeDirectory(repoPath)
  yield* runGitCommand({ args: ['init', '--bare'], cwd: repoPath })

  // Create a temp repo, add commit, push to bare
  const tempRepoPath = `${tmpDir}/temp-repo`
  yield* fs.makeDirectory(tempRepoPath)
  yield* runGitCommand({ args: ['init'], cwd: tempRepoPath })
  yield* runGitCommand({ args: ['config', 'user.email', 'test@test.com'], cwd: tempRepoPath })
  yield* runGitCommand({ args: ['config', 'user.name', 'Test'], cwd: tempRepoPath })
  yield* fs.writeFileString(`${tempRepoPath}/README.md`, `# ${name}\n`)
  yield* runGitCommand({ args: ['add', '.'], cwd: tempRepoPath })
  yield* runGitCommand({
    args: ['commit', '--no-verify', '-m', 'Initial commit'],
    cwd: tempRepoPath,
  })
  yield* runGitCommand({ args: ['push', repoPath, 'HEAD:main'], cwd: tempRepoPath })

  // Clean up temp repo
  yield* fs.remove(tempRepoPath, { recursive: true })

  return repoPath
})

/** Add a commit to a repo */
export const addCommit = Effect.fnUntraced(function* ({
  repoPath,
  message,
  filename,
}: {
  repoPath: string
  message: string
  filename?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const file = filename ?? `file-${Date.now()}.txt`
  yield* fs.writeFileString(`${repoPath}/${file}`, `${message}\n`)
  yield* runGitCommand({ args: ['add', '.'], cwd: repoPath })
  yield* runGitCommand({ args: ['commit', '--no-verify', '-m', message], cwd: repoPath })
  return yield* getGitRev(repoPath)
})

/** Read the root config file content */
export const readConfig = Effect.fnUntraced(function* (workspacePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(`${workspacePath}/dotdot-root.json`)
})

/** Create package target directory with files */
export const createPackageTarget = Effect.fnUntraced(function* ({
  repoPath,
  packagePath,
}: {
  repoPath: string
  packagePath: string
}) {
  const fs = yield* FileSystem.FileSystem
  const targetPath = `${repoPath}/${packagePath}`
  yield* fs.makeDirectory(targetPath, { recursive: true })
  yield* fs.writeFileString(`${targetPath}/package.json`, '{"name": "test-package"}\n')
})

type PackageIndexEntry = { repo: string; path: string; install?: string }

/** Generate root config JSON with repos and packages index */
export const generateRootConfig = ({
  repos,
  packages,
}: {
  repos: Record<string, { url: string; rev?: string; install?: string }>
  packages?: Record<string, PackageIndexEntry>
}): string => {
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
export const generateMemberConfig = ({
  exposes,
  deps,
}: {
  exposes?: Record<string, { path: string; install?: string }>
  deps?: Record<string, { url: string; rev?: string }>
}): string => {
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

/** Normalize status output for snapshot comparison by stripping ANSI codes and replacing dynamic values */
export const normalizeStatusOutput = (output: string, workspaceName?: string): string => {
  let normalized = output
    // Strip ANSI escape codes
    // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
    .replace(/\x1b\[[0-9;]*m/g, '')
    // Replace full 40-char hashes
    .replace(/[a-f0-9]{40}/g, '<FULL_HASH>')
    // Replace 7-8 char short hashes in @hash format
    .replace(/@[a-f0-9]{7,8}\b/g, '@<SHORT_HASH>')
    // Replace hashes in "(local: xxx, remote: xxx)" format
    .replace(
      /\(local: [a-f0-9]{7}, remote: [a-f0-9]{7}\)/g,
      '(local: <SHORT_HASH>, remote: <SHORT_HASH>)',
    )
    // Replace diverged hash indicator
    .replace(/↕[a-f0-9]{7}/g, '↕<SHORT_HASH>')

  // Replace workspace basename if provided
  if (workspaceName) {
    normalized = normalized.replace(new RegExp(workspaceName, 'g'), '<WORKSPACE>')
  }

  return normalized
}
