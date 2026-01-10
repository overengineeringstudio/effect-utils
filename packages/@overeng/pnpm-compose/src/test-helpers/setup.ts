/**
 * Test helpers for setting up integration test environments.
 * Creates realistic monorepo structures with submodules for testing pnpm-compose.
 */
import * as crypto from 'node:crypto'
import * as os from 'node:os'

import { Command, FileSystem, Path } from '@effect/platform'
import type { CommandExecutor, Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'

/** Test environment with a parent repo and submodules */
export interface TestEnv {
  /** Root directory of the test environment */
  root: string
  /** Run a command in the test environment */
  run: (args: {
    cmd: string
    args: string[]
    cwd?: string
  }) => Effect.Effect<string, PlatformError.PlatformError, CommandExecutor.CommandExecutor>
  /** Write a file relative to root */
  writeFile: (args: {
    path: string
    content: string
  }) => Effect.Effect<void, PlatformError.PlatformError>
  /** Read a file relative to root */
  readFile: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
  /** Check if a path exists */
  exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  /** Read symlink target */
  readLink: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
  /** Clean up the test environment */
  cleanup: () => Effect.Effect<void, PlatformError.PlatformError>
}

/** Options for creating a test environment */
export interface TestEnvOptions {
  /** Name prefix for the test directory */
  name?: string
  /** Whether to keep the directory after cleanup (for debugging) */
  keepOnCleanup?: boolean
}

/** Create a new test environment in a temporary directory */
export const createTestEnv = (options: TestEnvOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const tmpBase = os.tmpdir()
    const suffix = crypto.randomBytes(4).toString('hex')
    const name = options.name ?? 'pnpm-compose-test'
    const root = path.join(tmpBase, `${name}-${suffix}`)

    yield* fs.makeDirectory(root, { recursive: true })

    const run = ({ cmd, args, cwd }: { cmd: string; args: string[]; cwd?: string }) =>
      Effect.gen(function* () {
        const command = Command.make(cmd, ...args).pipe(Command.workingDirectory(cwd ?? root))
        // Use Command.string to get stdout as string directly
        const output = yield* Command.string(command)
        return output.trim()
      })

    const writeFile = ({ path: relativePath, content }: { path: string; content: string }) =>
      Effect.gen(function* () {
        const fullPath = path.join(root, relativePath)
        const dir = path.dirname(fullPath)
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(fullPath, content)
      })

    const readFile = (relativePath: string) => fs.readFileString(path.join(root, relativePath))

    const exists = (relativePath: string) => fs.exists(path.join(root, relativePath))

    const readLink = (relativePath: string) => fs.readLink(path.join(root, relativePath))

    const cleanup = () =>
      options.keepOnCleanup ? Effect.void : fs.remove(root, { recursive: true })

    return {
      root,
      run,
      writeFile,
      readFile,
      exists,
      readLink,
      cleanup,
    } satisfies TestEnv
  })

/** Create a basic monorepo structure with a submodule */
export const setupBasicMonorepo = (env: TestEnv) =>
  Effect.gen(function* () {
    // Initialize parent git repo
    yield* env.run({ cmd: 'git', args: ['init'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.email', 'test@test.com'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.name', 'Test'] })
    yield* env.run({ cmd: 'git', args: ['config', 'commit.gpgsign', 'false'] })

    // Create parent package.json
    yield* env.writeFile({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'test-monorepo',
          private: true,
        },
        null,
        2,
      ),
    })

    // Create pnpm-workspace.yaml with submodule packages
    yield* env.writeFile({
      path: 'pnpm-workspace.yaml',
      content: `packages:
  - packages/*
  - submodules/lib/packages/*
`,
    })

    // Create a package in parent repo
    yield* env.writeFile({
      path: 'packages/app/package.json',
      content: JSON.stringify(
        {
          name: 'app',
          version: '1.0.0',
          dependencies: {
            '@test/utils': 'workspace:*',
          },
        },
        null,
        2,
      ),
    })

    // Create submodule directory structure (simulated - not actual git submodule for simplicity)
    yield* env.writeFile({
      path: 'submodules/lib/package.json',
      content: JSON.stringify(
        {
          name: 'lib-root',
          private: true,
        },
        null,
        2,
      ),
    })

    yield* env.writeFile({
      path: 'submodules/lib/pnpm-workspace.yaml',
      content: `packages:
  - packages/*
`,
    })

    yield* env.writeFile({
      path: 'submodules/lib/packages/utils/package.json',
      content: JSON.stringify(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        null,
        2,
      ),
    })

    yield* env.writeFile({
      path: 'submodules/lib/packages/utils/index.js',
      content: 'export const foo = 42\n',
    })

    // Create .gitmodules to simulate git submodules
    yield* env.writeFile({
      path: '.gitmodules',
      content: `[submodule "submodules/lib"]
\tpath = submodules/lib
\turl = https://github.com/test/lib.git
`,
    })

    // Initialize the submodule as a git repo (needed for some pnpm behaviors)
    yield* env.run({ cmd: 'git', args: ['init'], cwd: `${env.root}/submodules/lib` })
    yield* env.run({
      cmd: 'git',
      args: ['config', 'user.email', 'test@test.com'],
      cwd: `${env.root}/submodules/lib`,
    })
    yield* env.run({
      cmd: 'git',
      args: ['config', 'user.name', 'Test'],
      cwd: `${env.root}/submodules/lib`,
    })
    yield* env.run({
      cmd: 'git',
      args: ['config', 'commit.gpgsign', 'false'],
      cwd: `${env.root}/submodules/lib`,
    })
  })

/** Simulate corruption by running pnpm install in a submodule */
export const simulatePnpmCorruption = ({
  env,
  submodulePath,
}: {
  env: TestEnv
  submodulePath: string
}) =>
  Effect.gen(function* () {
    const fullPath = `${env.root}/${submodulePath}`
    yield* env.run({ cmd: 'pnpm', args: ['install'], cwd: fullPath })
  })

/** Create a .modules.yaml file to simulate pnpm state */
export const createPnpmStateFile = ({
  env,
  nodeModulesPath,
}: {
  env: TestEnv
  nodeModulesPath: string
}) =>
  env.writeFile({
    path: `${nodeModulesPath}/.modules.yaml`,
    content: `hoistPattern:
  - '*'
layoutVersion: 5
nodeLinker: isolated
packageManager: pnpm@10.17.1
storeDir: /tmp/pnpm/store/v10
virtualStoreDir: .pnpm
`,
  })

/**
 * Create nested repos with duplicate submodules for testing deduplication.
 *
 * Uses local git submodules with real commits to exercise gitlink behavior.
 */
export const setupNestedSubmodules = (env: TestEnv) =>
  Effect.gen(function* () {
    const gitUser = [
      ['config', 'user.email', 'test@test.com'],
      ['config', 'user.name', 'Test'],
      ['config', 'commit.gpgsign', 'false'],
    ]

    const initRepo = ({ repoPath, label }: { repoPath: string; label: string }) =>
      Effect.gen(function* () {
        yield* env.writeFile({ path: `${repoPath}/README.md`, content: label })
        yield* env.run({ cmd: 'git', args: ['init'], cwd: `${env.root}/${repoPath}` })
        for (const args of gitUser) {
          yield* env.run({ cmd: 'git', args, cwd: `${env.root}/${repoPath}` })
        }
        yield* env.run({ cmd: 'git', args: ['add', 'README.md'], cwd: `${env.root}/${repoPath}` })
        yield* env.run({
          cmd: 'git',
          args: ['commit', '-m', 'init'],
          cwd: `${env.root}/${repoPath}`,
        })
      })

    const utilsOrigin = `${env.root}/repos/utils-origin`
    const libAOrigin = `${env.root}/repos/lib-a-origin`
    const libBOrigin = `${env.root}/repos/lib-b-origin`

    yield* initRepo({ repoPath: 'repos/utils-origin', label: 'utils-origin' })
    yield* initRepo({ repoPath: 'repos/lib-a-origin', label: 'lib-a-origin' })
    yield* initRepo({ repoPath: 'repos/lib-b-origin', label: 'lib-b-origin' })

    yield* env.run({ cmd: 'git', args: ['init'] })
    for (const args of gitUser) {
      yield* env.run({ cmd: 'git', args })
    }

    yield* env.run({
      cmd: 'git',
      args: [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        utilsOrigin,
        'submodules/utils',
      ],
    })
    yield* env.run({
      cmd: 'git',
      args: [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        libAOrigin,
        'submodules/lib-a',
      ],
    })
    yield* env.run({
      cmd: 'git',
      args: [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        libBOrigin,
        'submodules/lib-b',
      ],
    })

    yield* env.run({
      cmd: 'git',
      args: ['add', '.gitmodules', 'submodules/utils', 'submodules/lib-a', 'submodules/lib-b'],
    })
    yield* env.run({ cmd: 'git', args: ['commit', '-m', 'add submodules'] })

    for (const lib of ['lib-a', 'lib-b']) {
      const libPath = `${env.root}/submodules/${lib}`
      for (const args of gitUser) {
        yield* env.run({ cmd: 'git', args, cwd: libPath })
      }
      yield* env.run({
        cmd: 'git',
        args: [
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          utilsOrigin,
          'submodules/utils',
        ],
        cwd: libPath,
      })
      yield* env.run({
        cmd: 'git',
        args: ['add', '.gitmodules', 'submodules/utils'],
        cwd: libPath,
      })
      yield* env.run({
        cmd: 'git',
        args: ['commit', '-m', 'add nested utils submodule'],
        cwd: libPath,
      })
    }

    yield* env.run({ cmd: 'git', args: ['add', 'submodules/lib-a', 'submodules/lib-b'] })
    yield* env.run({ cmd: 'git', args: ['commit', '-m', 'update nested submodules'] })
  })
