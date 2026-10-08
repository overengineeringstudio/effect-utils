import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import * as Command from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { makeTempGitEnvironment, Vitest } from './mod.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const commitArgs = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'initial',
]

const git = Effect.fn('git-environment.fixture')(
  ({ cwd, args, env }: { cwd: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }) =>
    ChildProcessSpawner.use((spawner) => spawner.string(Command.make('git', args, { cwd, env }))),
)

Vitest.it.effect('fixture commits preserve the hook caller HEAD and staged index', (test) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
    const caller = `${root}/caller`
    const fixture = `${root}/fixture`
    // Setup must be safe even if the isolation helper regresses.
    const setupEnvironment = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    }
    yield* fs.makeDirectory(caller)
    yield* fs.makeDirectory(fixture)
    yield* git({ cwd: caller, args: ['init', '-q'], env: setupEnvironment })
    yield* fs.writeFileString(`${caller}/caller.txt`, 'committed\n')
    yield* git({ cwd: caller, args: ['add', 'caller.txt'], env: setupEnvironment })
    yield* git({ cwd: caller, args: commitArgs, env: setupEnvironment })
    yield* fs.writeFileString(`${caller}/caller.txt`, 'staged by caller\n')
    yield* git({ cwd: caller, args: ['add', 'caller.txt'], env: setupEnvironment })
    const headBefore = yield* git({
      cwd: caller,
      args: ['rev-parse', 'HEAD'],
      env: setupEnvironment,
    })
    const indexBefore = yield* fs.readFile(`${caller}/.git/index`)

    const hookEnvironment = {
      ...setupEnvironment,
      GIT_DIR: `${caller}/.git`,
      GIT_WORK_TREE: caller,
      GIT_INDEX_FILE: `${caller}/.git/index`,
      GIT_OBJECT_DIRECTORY: `${caller}/.git/objects`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `${caller}/.git/objects`,
      GIT_COMMON_DIR: `${caller}/.git`,
      GIT_PREFIX: 'hook-prefix/',
    }
    const fixtureEnvironment = makeTempGitEnvironment(hookEnvironment)
    yield* git({ cwd: fixture, args: ['init', '-q'], env: fixtureEnvironment })
    yield* fs.writeFileString(`${fixture}/fixture.txt`, 'fixture content\n')
    yield* git({ cwd: fixture, args: ['add', 'fixture.txt'], env: fixtureEnvironment })
    yield* git({ cwd: fixture, args: commitArgs, env: fixtureEnvironment })

    expect(yield* git({ cwd: caller, args: ['rev-parse', 'HEAD'], env: setupEnvironment })).toBe(
      headBefore,
    )
    expect(yield* fs.readFile(`${caller}/.git/index`)).toEqual(indexBefore)
    expect(
      yield* git({
        cwd: fixture,
        args: ['ls-tree', '--name-only', 'HEAD'],
        env: fixtureEnvironment,
      }),
    ).toBe('fixture.txt\n')
  }).pipe(Effect.scoped, withTestCtx(test)),
)
