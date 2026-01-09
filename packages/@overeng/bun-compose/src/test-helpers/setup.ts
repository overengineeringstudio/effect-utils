/**
 * Test helpers for setting up integration test environments.
 * Creates realistic monorepo structures with submodules for testing bun-compose.
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
    const name = options.name ?? 'bun-compose-test'
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

/**
 * Create a basic monorepo structure with a submodule for bun workspace testing.
 * Uses bun's package.json catalog format.
 */
export const setupBasicMonorepo = (env: TestEnv) =>
  Effect.gen(function* () {
    // Initialize parent git repo
    yield* env.run({ cmd: 'git', args: ['init'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.email', 'test@test.com'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.name', 'Test'] })

    // Create parent package.json with bun workspace catalog
    yield* env.writeFile({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'test-monorepo',
          private: true,
          workspaces: {
            packages: ['packages/*', 'submodules/lib/packages/*'],
            catalog: {
              effect: '3.19.0',
            },
          },
        },
        null,
        2,
      ),
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
            effect: 'catalog:',
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
          workspaces: {
            packages: ['packages/*'],
            catalog: {
              effect: '3.19.0',
            },
          },
        },
        null,
        2,
      ),
    })

    yield* env.writeFile({
      path: 'submodules/lib/packages/utils/package.json',
      content: JSON.stringify(
        {
          name: '@test/utils',
          version: '1.0.0',
          dependencies: {
            effect: 'catalog:',
          },
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

    // Initialize the submodule as a git repo (needed for some behaviors)
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
  })

/**
 * Create a monorepo with catalog version conflicts for testing alignment checks.
 */
export const setupMonorepoWithConflicts = (env: TestEnv) =>
  Effect.gen(function* () {
    // Initialize parent git repo
    yield* env.run({ cmd: 'git', args: ['init'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.email', 'test@test.com'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.name', 'Test'] })

    // Create parent package.json with bun workspace catalog (effect 3.19.0)
    yield* env.writeFile({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'test-monorepo',
          private: true,
          workspaces: {
            packages: ['packages/*', 'submodules/lib/packages/*'],
            catalog: {
              effect: '3.19.0',
              typescript: '5.9.0',
            },
          },
        },
        null,
        2,
      ),
    })

    // Create submodule with CONFLICTING catalog (effect 3.18.0 - lower version)
    yield* env.writeFile({
      path: 'submodules/lib/package.json',
      content: JSON.stringify(
        {
          name: 'lib-root',
          private: true,
          workspaces: {
            packages: ['packages/*'],
            catalog: {
              effect: '3.18.0', // Conflict: different version
              typescript: '5.9.0', // Same version - no conflict
            },
          },
        },
        null,
        2,
      ),
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

    // Create .gitmodules
    yield* env.writeFile({
      path: '.gitmodules',
      content: `[submodule "submodules/lib"]
\tpath = submodules/lib
\turl = https://github.com/test/lib.git
`,
    })

    // Initialize submodule git repo
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
  })

/**
 * Create a monorepo with genie/repo.ts catalog (higher priority than package.json).
 */
export const setupMonorepoWithGenieCatalog = (env: TestEnv) =>
  Effect.gen(function* () {
    // Initialize parent git repo
    yield* env.run({ cmd: 'git', args: ['init'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.email', 'test@test.com'] })
    yield* env.run({ cmd: 'git', args: ['config', 'user.name', 'Test'] })

    // Create parent package.json (minimal, no catalog here)
    yield* env.writeFile({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'test-monorepo',
          private: true,
          workspaces: ['packages/*', 'submodules/lib/packages/*'],
        },
        null,
        2,
      ),
    })

    // Create genie/repo.ts with catalog
    yield* env.writeFile({
      path: 'genie/repo.ts',
      content: `export const catalog = {
  effect: '3.19.0',
  typescript: '5.9.0',
} as const
`,
    })

    // Create submodule with its own genie/repo.ts
    yield* env.writeFile({
      path: 'submodules/lib/package.json',
      content: JSON.stringify(
        {
          name: 'lib-root',
          private: true,
          workspaces: ['packages/*'],
        },
        null,
        2,
      ),
    })

    yield* env.writeFile({
      path: 'submodules/lib/genie/repo.ts',
      content: `export const catalog = {
  effect: '3.19.0',
  typescript: '5.9.0',
} as const
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

    // Create .gitmodules
    yield* env.writeFile({
      path: '.gitmodules',
      content: `[submodule "submodules/lib"]
\tpath = submodules/lib
\turl = https://github.com/test/lib.git
`,
    })

    // Initialize submodule git repo
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
  })
