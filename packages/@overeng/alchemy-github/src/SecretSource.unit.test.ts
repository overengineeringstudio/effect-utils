import { it } from '@effect/vitest'
import { Effect, Layer, Schema, Sink, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ProcessSpawner from 'effect/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { SecretSource, SecretSourceLive, type SecretHandle } from './SecretSource.ts'
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const handle: SecretHandle = {
  ref: 'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password',
  reason: 'Publish the synthetic Actions test credential',
}

const fixture = ({ stdout = '"synthetic"\n', code = 0, fail = false } = {}) => {
  const commands: Array<ChildProcess.Command> = []
  const layer = Layer.succeed(
    ProcessSpawner.ChildProcessSpawner,
    ProcessSpawner.make((command) => {
      commands.push(command)
      if (fail === true)
        return Effect.fail(
          PlatformError.systemError({
            _tag: 'NotFound',
            module: 'ChildProcess',
            method: 'spawn',
            description: 'synthetic-secret-in-spawn-error',
          }),
        )
      return Effect.succeed(
        ProcessSpawner.makeHandle({
          pid: ProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.make(new TextEncoder().encode('synthetic-secret-in-stderr')),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
  return { commands, layer: SecretSourceLive.pipe(Layer.provide(layer)) }
}

for (const invalid of [
  { ...handle, ref: 'op://Private/GitHub/password' },
  { ...handle, ref: 'op://abcdefghijklmnopqrstuvwxyz/GitHub/password' },
  { ...handle, ref: 'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/' },
  { ...handle, ref: 'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/   ' },
  { ...handle, ref: 'op://abcdefghijklmnopqrstuvwxyz/abcdefghijklmnopqrstuvwxyz/password\0' },
  { ...handle, reason: '' },
  { ...handle, reason: ' \t\n ' },
  { ...handle, reason: 'reason\0suffix' },
] satisfies ReadonlyArray<SecretHandle>) {
  it.effect(`rejects invalid handle ${encode(invalid)}`, () =>
    Effect.gen(function* () {
      const test = fixture()
      const result = yield* SecretSource.use((source) => source.read(invalid)).pipe(
        Effect.result,
        Effect.provide(test.layer),
      )
      expect(result._tag).toBe('Failure')
      expect(test.commands).toHaveLength(0)
    }),
  )
}

it.effect('decodes the JSON scalar without trimming, normalizing, or retaining framing', () =>
  Effect.gen(function* () {
    const value = ' \tline one\r\nline two\u0000é漢𝄞\n '
    const test = fixture({ stdout: `${encode(value)}\n` })
    const bytes = yield* SecretSource.use((source) => source.read(handle)).pipe(
      Effect.provide(test.layer),
    )
    expect(bytes).toEqual(new TextEncoder().encode(value))
    bytes.fill(0)
    expect(bytes.every((byte) => byte === 0)).toBe(true)
    const command = test.commands[0]!
    expect(ChildProcess.isStandardCommand(command)).toBe(true)
    if (ChildProcess.isStandardCommand(command) === true) {
      expect(command.command).toBe('op-proxy')
      expect(command.args).toEqual([
        'read',
        handle.ref,
        '--reason',
        handle.reason,
        '--cache',
        'none',
        '--fresh',
        '--output',
        'json',
      ])
      expect(command.options.stderr).toBe('ignore')
      expect(command.options.stdin).toBe('ignore')
    }
  }),
)

for (const options of [
  { code: 1, stdout: 'synthetic-secret-in-stdout' },
  { fail: true },
  { stdout: 'synthetic-secret-invalid-json' },
  { stdout: '{"secret":"synthetic-secret-object"}' },
  { stdout: '"' + 'x'.repeat(512 * 1024) + '"' },
]) {
  it.effect(
    `sanitizes process/output failure ${options.code ?? options.fail ?? options.stdout?.length}`,
    () =>
      Effect.gen(function* () {
        const test = fixture(options)
        const result = yield* SecretSource.use((source) => source.read(handle)).pipe(
          Effect.result,
          Effect.provide(test.layer),
        )
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('GitHubActionsError')
          expect(String(result.failure)).not.toContain('synthetic-secret')
          expect(encode(result.failure)).not.toContain('synthetic-secret')
          expect(result.failure).not.toHaveProperty('cause')
        }
      }),
  )
}
