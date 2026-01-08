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
  run: (
    cmd: string,
    args: string[],
    cwd?: string,
  ) => Effect.Effect<string, PlatformError.PlatformError, CommandExecutor.CommandExecutor>
  /** Write a file relative to root */
  writeFile: (path: string, content: string) => Effect.Effect<void, PlatformError.PlatformError>
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

    const run = (cmd: string, args: string[], cwd?: string) =>
      Effect.gen(function* () {
        const command = Command.make(cmd, ...args).pipe(Command.workingDirectory(cwd ?? root))
        // Use Command.string to get stdout as string directly
        const output = yield* Command.string(command)
        return output.trim()
      })

    const writeFile = (relativePath: string, content: string) =>
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
    yield* env.run('git', ['init'])
    yield* env.run('git', ['config', 'user.email', 'test@test.com'])
    yield* env.run('git', ['config', 'user.name', 'Test'])

    // Create parent package.json
    yield* env.writeFile(
      'package.json',
      JSON.stringify(
        {
          name: 'test-monorepo',
          private: true,
        },
        null,
        2,
      ),
    )

    // Create pnpm-workspace.yaml with submodule packages
    yield* env.writeFile(
      'pnpm-workspace.yaml',
      `packages:
  - packages/*
  - submodules/lib/packages/*
`,
    )

    // Create a package in parent repo
    yield* env.writeFile(
      'packages/app/package.json',
      JSON.stringify(
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
    )

    // Create submodule directory structure (simulated - not actual git submodule for simplicity)
    yield* env.writeFile(
      'submodules/lib/package.json',
      JSON.stringify(
        {
          name: 'lib-root',
          private: true,
        },
        null,
        2,
      ),
    )

    yield* env.writeFile(
      'submodules/lib/pnpm-workspace.yaml',
      `packages:
  - packages/*
`,
    )

    yield* env.writeFile(
      'submodules/lib/packages/utils/package.json',
      JSON.stringify(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        null,
        2,
      ),
    )

    yield* env.writeFile('submodules/lib/packages/utils/index.js', 'export const foo = 42\n')

    // Create .gitmodules to simulate git submodules
    yield* env.writeFile(
      '.gitmodules',
      `[submodule "submodules/lib"]
\tpath = submodules/lib
\turl = https://github.com/test/lib.git
`,
    )

    // Initialize the submodule as a git repo (needed for some pnpm behaviors)
    yield* env.run('git', ['init'], `${env.root}/submodules/lib`)
    yield* env.run('git', ['config', 'user.email', 'test@test.com'], `${env.root}/submodules/lib`)
    yield* env.run('git', ['config', 'user.name', 'Test'], `${env.root}/submodules/lib`)
  })

/** Simulate corruption by running pnpm install in a submodule */
export const simulatePnpmCorruption = (env: TestEnv, submodulePath: string) =>
  Effect.gen(function* () {
    const fullPath = `${env.root}/${submodulePath}`
    yield* env.run('pnpm', ['install'], fullPath)
  })

/** Create a .modules.yaml file to simulate pnpm state */
export const createPnpmStateFile = (env: TestEnv, nodeModulesPath: string) =>
  env.writeFile(
    `${nodeModulesPath}/.modules.yaml`,
    `hoistPattern:
  - '*'
layoutVersion: 5
nodeLinker: isolated
packageManager: pnpm@10.17.1
storeDir: /tmp/pnpm/store/v10
virtualStoreDir: .pnpm
`,
  )
