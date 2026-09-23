import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  authoritativeBuck2TypeScriptDeclarations,
  type AuthoritativeBuck2TypeScriptDeclaration,
} from './typescript-admissions.ts'
import {
  type CommandArgv,
  type CommandOutcome,
  type CommandRuntime,
  executeCommandPlan,
  type ForwardedSignal,
  materializeTypeScriptDist,
  planTypeScriptDistMaterialization,
} from './typescript-authority-runtime.ts'

const fixtureAdmissions = [
  {
    declarationEntrypoint: 'types/index.d.ts',
    distTarget: '//packages/@example/widget:dist',
    packagePath: 'packages/@example/widget',
    projectFile: 'tsconfig.buck.json',
    projectPath: 'packages/@example/widget',
    typecheckTarget: '//packages/@example/widget:typecheck',
  },
] as const satisfies readonly AuthoritativeBuck2TypeScriptDeclaration[]

type SpawnedCommand = {
  readonly command: CommandArgv
  readonly forwardedSignals: ForwardedSignal[]
  readonly resolve: (outcome: CommandOutcome) => void
}

const makeCommandRuntime = () => {
  const spawnedCommands: SpawnedCommand[] = []
  const signalListeners: Record<ForwardedSignal, Set<() => void>> = {
    SIGINT: new Set(),
    SIGTERM: new Set(),
  }
  const runtime: CommandRuntime = {
    spawn: (command) => {
      let resolveCompletion: (outcome: CommandOutcome) => void = () => undefined
      const completion = new Promise<CommandOutcome>((resolve) => {
        resolveCompletion = resolve
      })
      const forwardedSignals: ForwardedSignal[] = []
      spawnedCommands.push({
        command,
        forwardedSignals,
        resolve: resolveCompletion,
      })
      return {
        completion,
        forwardSignal: (signal) => {
          forwardedSignals.push(signal)
        },
      }
    },
    addSignalListener: ({ signal, listener }) => {
      signalListeners[signal].add(listener)
    },
    removeSignalListener: ({ signal, listener }) => {
      signalListeners[signal].delete(listener)
    },
  }
  return {
    emitSignal: (signal: ForwardedSignal) => {
      for (const listener of signalListeners[signal]) listener()
    },
    runtime,
    signalListeners,
    spawnedCommands,
  }
}

const successfulCommandOutcome: CommandOutcome = { _tag: 'Status', status: 0 }

const makeMaterializationRuntime = ({
  cleanupOutcome = successfulCommandOutcome,
  invalidatePublishedDist = false,
}: {
  readonly cleanupOutcome?: CommandOutcome
  readonly invalidatePublishedDist?: boolean
} = {}): CommandRuntime => {
  let publishCount = 0
  return {
    spawn: (command) => {
      try {
        const [executable, ...args] = command
        if (executable === '/tools/buck2') {
          const output = args.at(args.indexOf('--out') + 1)!
          mkdirSync(join(output, 'types'), { recursive: true })
          writeFileSync(join(output, 'types/index.d.ts'), 'export type Fresh = true\n')
        } else if (executable === '/tools/mv') {
          const source = args.at(-2)!
          const destination = args.at(-1)!
          if (args.includes('--exchange')) {
            const previous = `${source}.exchange`
            renameSync(source, previous)
            renameSync(destination, source)
            renameSync(previous, destination)
          } else {
            renameSync(source, destination)
          }
          publishCount += 1
          if (invalidatePublishedDist === true && publishCount === 1)
            rmSync(join(destination, 'types/index.d.ts'))
        }
        return {
          completion: Promise.resolve(
            executable === '/tools/chmod' ? cleanupOutcome : successfulCommandOutcome,
          ),
          forwardSignal: () => undefined,
        }
      } catch {
        return {
          completion: Promise.resolve({ _tag: 'Status', status: 1 }),
          forwardSignal: () => undefined,
        }
      }
    },
    addSignalListener: () => undefined,
    removeSignalListener: () => undefined,
  }
}

describe('Buck2 TypeScript authority runtime planning', () => {
  it('plans exact commands from an injected admission', () => {
    expect(
      planTypeScriptDistMaterialization({
        admissions: fixtureAdmissions,
        buck2Bin: '/workspace/bin/buck2',
        bunBin: '/nix/store/bun/bin/bun',
        chmodBin: '/nix/store/coreutils/bin/chmod',
        mvBin: '/nix/store/coreutils/bin/mv',
        root: '/repo',
        runtimeSource: '/repo/genie/buck2/typescript-authority-runtime.ts',
        workspaceRoot: '/workspace',
      }),
    ).toEqual([
      [
        '/nix/store/bun/bin/bun',
        '/repo/genie/buck2/typescript-authority-runtime.ts',
        'materialize-one',
        '/repo',
        '/workspace',
        '/workspace/bin/buck2',
        '/nix/store/coreutils/bin/mv',
        '/nix/store/coreutils/bin/chmod',
        'packages/@example/widget',
        'effect_utils//packages/@example/widget:dist',
        'types/index.d.ts',
      ],
    ])

  })

  it('preserves command coverage and ordering for the live registry', () => {
    expect(
      planTypeScriptDistMaterialization({
        buck2Bin: '/workspace/bin/buck2',
        bunBin: '/nix/store/bun/bin/bun',
        chmodBin: '/nix/store/coreutils/bin/chmod',
        mvBin: '/nix/store/coreutils/bin/mv',
        root: '/repo',
        runtimeSource: '/repo/genie/buck2/typescript-authority-runtime.ts',
        workspaceRoot: '/workspace',
      }),
    ).toEqual(
      authoritativeBuck2TypeScriptDeclarations.map(
        ({ declarationEntrypoint, distTarget, packagePath }) => [
          '/nix/store/bun/bin/bun',
          '/repo/genie/buck2/typescript-authority-runtime.ts',
          'materialize-one',
          '/repo',
          '/workspace',
          '/workspace/bin/buck2',
          '/nix/store/coreutils/bin/mv',
          '/nix/store/coreutils/bin/chmod',
          packagePath,
          `effect_utils${distTarget}`,
          declarationEntrypoint,
        ],
      ),
    )

  })

  it('atomically replaces a stale declaration tree and removes staging state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typescript-dist-runtime-'))
    const packageDirectory = join(root, 'packages/@example/widget')
    const dist = join(packageDirectory, 'dist')
    const workspaceRoot = join(root, 'workspace')
    try {
      mkdirSync(join(dist, 'types'), { recursive: true })
      mkdirSync(workspaceRoot)
      writeFileSync(join(dist, 'types/index.d.ts'), 'export type Stale = true\n')

      await expect(
        materializeTypeScriptDist({
          buck2Bin: '/tools/buck2',
          chmodBin: '/tools/chmod',
          declarationEntrypoint: 'types/index.d.ts',
          mvBin: '/tools/mv',
          packagePath: 'packages/@example/widget',
          root,
          runtime: makeMaterializationRuntime(),
          target: 'effect_utils//packages/@example/widget:dist',
          workspaceRoot,
        }),
      ).resolves.toEqual({ _tag: 'Status', status: 0 })
      expect(readFileSync(join(dist, 'types/index.d.ts'), 'utf8')).toBe(
        'export type Fresh = true\n',
      )
      expect(readdirSync(packageDirectory).filter((name) => name.startsWith('.dist-buck2.'))).toEqual(
        [],
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('propagates a cleanup signal after removing staging state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typescript-dist-cleanup-signal-'))
    const packageDirectory = join(root, 'packages/@example/widget')
    const workspaceRoot = join(root, 'workspace')
    try {
      mkdirSync(packageDirectory, { recursive: true })
      mkdirSync(workspaceRoot)

      await expect(
        materializeTypeScriptDist({
          buck2Bin: '/tools/buck2',
          chmodBin: '/tools/chmod',
          declarationEntrypoint: 'types/index.d.ts',
          mvBin: '/tools/mv',
          packagePath: 'packages/@example/widget',
          root,
          runtime: makeMaterializationRuntime({
            cleanupOutcome: { _tag: 'Signal', signal: 'SIGTERM' },
          }),
          target: 'effect_utils//packages/@example/widget:dist',
          workspaceRoot,
        }),
      ).resolves.toEqual({ _tag: 'Signal', signal: 'SIGTERM' })
      expect(readdirSync(packageDirectory).filter((name) => name.startsWith('.dist-buck2.'))).toEqual(
        [],
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('restores the previous declaration tree when post-publish validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typescript-dist-rollback-'))
    const dist = join(root, 'packages/@example/widget/dist')
    const workspaceRoot = join(root, 'workspace')
    try {
      mkdirSync(join(dist, 'types'), { recursive: true })
      mkdirSync(workspaceRoot)
      writeFileSync(join(dist, 'types/index.d.ts'), 'export type Stale = true\n')

      await expect(
        materializeTypeScriptDist({
          buck2Bin: '/tools/buck2',
          chmodBin: '/tools/chmod',
          declarationEntrypoint: 'types/index.d.ts',
          mvBin: '/tools/mv',
          packagePath: 'packages/@example/widget',
          root,
          runtime: makeMaterializationRuntime({ invalidatePublishedDist: true }),
          target: 'effect_utils//packages/@example/widget:dist',
          workspaceRoot,
        }),
      ).rejects.toThrow('is missing types/index.d.ts')
      expect(readFileSync(join(dist, 'types/index.d.ts'), 'utf8')).toBe(
        'export type Stale = true\n',
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('forwards task signals to the active child and propagates its signal outcome', async () => {
    const { emitSignal, runtime, signalListeners, spawnedCommands } = makeCommandRuntime()
    const execution = executeCommandPlan({
      commands: [['first'], ['second']],
      runtime,
    })

    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first']])
    emitSignal('SIGTERM')
    expect(spawnedCommands[0]?.forwardedSignals).toEqual(['SIGTERM'])
    spawnedCommands[0]?.resolve({ _tag: 'Signal', signal: 'SIGTERM' })

    await expect(execution).resolves.toEqual({ _tag: 'Signal', signal: 'SIGTERM' })
    expect(spawnedCommands).toHaveLength(1)
    expect(signalListeners.SIGINT.size).toBe(0)
    expect(signalListeners.SIGTERM.size).toBe(0)
  })

  it('keeps commands sequential and propagates the first non-zero status', async () => {
    const { runtime, spawnedCommands } = makeCommandRuntime()
    const execution = executeCommandPlan({
      commands: [['first'], ['second'], ['unreached']],
      runtime,
    })

    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first']])
    spawnedCommands[0]?.resolve({ _tag: 'Status', status: 0 })
    await Promise.resolve()
    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first'], ['second']])
    spawnedCommands[1]?.resolve({ _tag: 'Status', status: 17 })

    await expect(execution).resolves.toEqual({ _tag: 'Status', status: 17 })
    expect(spawnedCommands.map(({ command }) => command)).toEqual([['first'], ['second']])
  })
})
