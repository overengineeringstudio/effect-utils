import * as Http from 'node:http'
import { dirname, isAbsolute, resolve } from 'node:path'

import { NodeHttpServer } from '@effect/platform-node'
import { Console, Effect, Layer, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { EffectPath } from '@overeng/effect-path'

import { makePoolController, PoolControllerConfig, PoolControllerRequest } from '../../../store/store-pool-controller.ts'
import { runPoolCommand } from '../../../store/store-pool-install.ts'
import { PoolError } from '../../../store/store-pool-state.ts'

const socketFlag = Cli.Flag.String('socket').pipe(Cli.Flag.withDescription('Private host-local Unix socket path'))
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(PoolControllerRequest), { onExcessProperty: 'error' })

/** Never repairs a shared directory or removes another service's socket. A stale
 * endpoint is an explicit operator decision, not authority to adopt old roots. */
const privateSocket = (socket: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const parent = dirname(socket)
  if (!isAbsolute(socket) || resolve(socket) !== socket || socket.includes('\0'))
    return yield* new PoolError({ message: 'Canonical absolute pool socket required' })
  const info = yield* fs.lstat(parent)
  if (process.getuid === undefined || info.type !== 'Directory' || (info.mode & 0o077) !== 0 ||
    Option.getOrUndefined(info.uid) !== process.getuid() || (yield* fs.realPath(parent)) !== parent)
    return yield* new PoolError({ message: 'Pool socket parent must be canonical, owner-only and owned by current UID' })
})

const send = (socket: string, request: PoolControllerRequest) => Effect.gen(function* () {
  yield* privateSocket(socket)
  const output = yield* runPoolCommand({ cwd: dirname(socket), command: 'curl', args: [
    '--silent', '--show-error', '--fail-with-body', '--unix-socket', socket,
    '--header', 'content-type: application/json', '--data-binary', json(request), 'http://localhost/v1/pool',
  ] })
  yield* Console.log(output)
})

/** Real foreground service: the same actor handles birth, claims and reset, and
 * its death leaves durable barriers and uncertain capacity retained. */
export const poolServiceCommand = Cli.Command.make('service', {
  config: Cli.Flag.String('config'), socket: socketFlag,
}, ({ config: configPath, socket }) => Effect.gen(function* () {
  if (process.platform !== 'linux') return yield* new PoolError({ message: 'Physical pool service requires Linux native holder and systemd user services' })
  yield* privateSocket(socket)
  const fs = yield* FileSystem.FileSystem
  const config = yield* Schema.decodeEffect(Schema.fromJsonString(PoolControllerConfig), {
    onExcessProperty: 'error',
  })(yield* fs.readFileString(configPath))
  const canonical = yield* fs.realPath(config.base)
  if (canonical !== config.base || (yield* fs.realPath(config.devenvProvider)) !== config.devenvProvider)
    return yield* new PoolError({ message: 'Canonical pool store and immutable devenv provider required' })
  const mainPid = yield* runPoolCommand({ cwd: canonical, command: 'systemctl',
    args: ['--user', 'show', config.serviceUnit, '--property=MainPID', '--value'] })
  if (mainPid !== String(process.pid))
    return yield* new PoolError({ message: 'Pool controller must be the actual configured user service MainPID' })
  const base = EffectPath.unsafe.absoluteDir(`${canonical}/`)
  const controller = yield* makePoolController(config, base)
  const router = HttpRouter.addAll([
    HttpRouter.route('POST', '/v1/pool', Effect.gen(function* () {
      const incoming = yield* HttpServerRequest.HttpServerRequest
      const request = yield* decodeRequest(yield* incoming.text)
      const result = yield* controller.execute(request)
      return HttpServerResponse.jsonUnsafe({ version: 1, result }, {
        status: 'success' in result && result.success === false ? 422 : 200,
      })
    }).pipe(Effect.catch((cause) => Effect.gen(function* () {
      yield* Effect.logError(cause)
      return HttpServerResponse.jsonUnsafe({
        version: 1, error: 'Request failed; root and capacity remain retained. Inspect service journal.',
      }, { status: 409 })
    })))),
    HttpRouter.route('GET', '/healthz', Effect.succeed(HttpServerResponse.jsonUnsafe({ version: 1, pid: process.pid }))),
  ])
  yield* Effect.log('Pool service accepting host-local requests; prior process roots remain HOLD')
  return yield* Layer.launch(HttpRouter.serve(router, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(() => Http.createServer(), { path: socket })),
  ))
}))

export const poolWarmCommand = Cli.Command.make('warm', { socket: socketFlag }, ({ socket }) =>
  send(socket, { operation: 'warm' }))

export const poolRunCommand = Cli.Command.make('run', {
  socket: socketFlag, id: Cli.Flag.String('id'), tasks: Cli.Flag.String('tasks'),
}, ({ socket, id, tasks }) => Effect.gen(function* () {
  const request = yield* decodeRequest(json({ operation: 'run', id, tasks: tasks.split(',') }))
  yield* send(socket, request)
}))

export const poolResetCommand = Cli.Command.make('reset', {
  socket: socketFlag, id: Cli.Flag.String('id'), mode: Cli.Flag.String('mode'),
}, ({ socket, id, mode }) => Effect.gen(function* () {
  const request = yield* decodeRequest(json({ operation: 'reset', id, mode }))
  yield* send(socket, request)
}))
