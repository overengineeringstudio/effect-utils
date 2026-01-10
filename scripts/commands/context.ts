import { Command } from '@effect/cli'
import { Console, Duration, Effect } from 'effect'

import { ciGroup, ciGroupEnd, runCommand, startProcess } from '@overeng/mono'
import { CurrentWorkingDirectory } from '@overeng/utils/node'

const contextExamplesCommand = Command.make('examples', {}, () =>
  Effect.gen(function* () {
    const workspaceRoot = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const socketCwd = `${workspaceRoot}/context/effect/socket`

    const runWithServer = <TResult, TError, TContext>(options: {
      label: string
      serverArgs: string[]
      clientEffect: Effect.Effect<TResult, TError, TContext>
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* ciGroup(options.label)

          yield* Effect.acquireRelease(
            startProcess({ command: 'bun', args: options.serverArgs, cwd: socketCwd }),
            (process) => process.kill('SIGTERM').pipe(Effect.catchAll(() => Effect.void)),
          )

          yield* Effect.sleep(Duration.seconds(1))
          return yield* options.clientEffect
        }).pipe(Effect.ensuring(ciGroupEnd)),
      )

    const httpWsClientScript = [
      'const ws = new WebSocket("ws://127.0.0.1:8790")',
      'const timeout = setTimeout(() => { console.error("timeout waiting for message"); ws.close(); process.exit(1) }, 2000)',
      'ws.onopen = () => ws.send("hello")',
      'ws.onmessage = (event) => { console.log("recv", event.data); clearTimeout(timeout); ws.close() }',
      'ws.onclose = () => process.exit(0)',
      'ws.onerror = (error) => { console.error(error); clearTimeout(timeout); process.exit(1) }',
    ].join('; ')

    yield* runWithServer({
      label: 'WS echo',
      serverArgs: ['examples/ws-echo-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-echo-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'WS broadcast',
      serverArgs: ['examples/ws-broadcast-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-broadcast-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'WS JSON',
      serverArgs: ['examples/ws-json-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-json-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'HTTP + WS combined',
      serverArgs: ['examples/http-ws-combined.ts'],
      clientEffect: Effect.gen(function* () {
        yield* runCommand({
          command: 'curl',
          args: ['-s', 'http://127.0.0.1:8788/'],
          cwd: workspaceRoot,
        })
        yield* runCommand({
          command: 'bun',
          args: ['-e', httpWsClientScript],
          cwd: workspaceRoot,
          shell: false,
        })
      }),
    })

    yield* runWithServer({
      label: 'RPC over WebSocket',
      serverArgs: ['examples/rpc-ws-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/rpc-ws-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'TCP echo',
      serverArgs: ['examples/tcp-echo-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/tcp-echo-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* Console.log('✓ Context examples complete')
  }),
).pipe(Command.withDescription('Run all context socket example scripts'))

/** CLI command for running context reference material subcommands */
export const contextCommand = Command.make('context').pipe(
  Command.withSubcommands([contextExamplesCommand]),
  Command.withDescription('Run commands for context reference material'),
)
