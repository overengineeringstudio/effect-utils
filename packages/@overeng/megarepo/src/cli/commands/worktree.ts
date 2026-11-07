import { isAbsolute } from 'node:path'

import { Effect, Option } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'

import { Cwd } from '../context.ts'

const worktree = Cli.Argument.String('worktree').pipe(
  Cli.Argument.withDescription(
    'Worktree or subdirectory; native Git identity resolution is authoritative',
  ),
)
const optional = (name: string) => Cli.Flag.String(name).pipe(Cli.Flag.optional)
const optionArgs = (name: string, value: Option.Option<string>): ReadonlyArray<string> =>
  Option.isSome(value) ? [`--${name}`, value.value] : []
const flagArgs = (name: string, enabled: boolean): ReadonlyArray<string> =>
  enabled ? [`--${name}`] : []
const command = Cli.Argument.String('command').pipe(
  Cli.Argument.withDescription('Command and arguments after --'),
  Cli.Argument.atLeast(1),
)

const runNative = Effect.fn('worktree.lease.native')(function* (args: ReadonlyArray<string>) {
  const cwd = yield* Cwd
  const child = yield* ChildProcess.make(
    process.env['WORKTREE_LEASE_BIN'] ?? 'worktree-lease',
    args,
    {
      cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  const code = yield* child.exitCode
  yield* Effect.sync(() => {
    process.exitCode = code
  })
})
const resolveNativePath = Effect.fn('worktree.lease.path')(function* (path: string) {
  const cwd = yield* Cwd
  const fs = yield* FileSystem.FileSystem
  const absolute = isAbsolute(path) ? path : `${cwd}${path}`
  // Preserve physical symlink/.. semantics. Unknown paths still reach native tagged refusal.
  return yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
})
const runWorktree = Effect.fn('worktree.lease.resolve')(function* (
  operation: string,
  path: string,
  args: ReadonlyArray<string>,
) {
  yield* runNative([operation, yield* resolveNativePath(path), ...args])
})

const create = Cli.Command.make(
  'create',
  {
    worktree,
    purpose: Cli.Flag.String('purpose'),
    creator: Cli.Flag.String('creator'),
    holderPid: optional('holder-pid'),
    ttl: Cli.Flag.String('ttl'),
  },
  ({ worktree, purpose, creator, holderPid, ttl }) =>
    runWorktree('create', worktree, [
      '--purpose',
      purpose,
      '--creator',
      creator,
      '--ttl',
      ttl,
      '--holder-pid',
      Option.getOrElse(holderPid, () => String(process.ppid)),
    ]),
).pipe(Cli.Command.withDescription('Publish finite creation attribution, not an active lease'))
const renew = Cli.Command.make(
  'renew',
  {
    worktree,
    holderPid: Cli.Flag.String('holder-pid'),
    agent: optional('agent'),
    ttl: Cli.Flag.String('ttl'),
  },
  ({ worktree, holderPid, agent, ttl }) =>
    runWorktree('renew', worktree, [
      '--holder-pid',
      holderPid,
      '--ttl',
      ttl,
      ...optionArgs('agent', agent),
    ]),
).pipe(Cli.Command.withDescription('Renew attribution through a native shared scope'))
const inspect = Cli.Command.make(
  'inspect',
  {
    worktree,
    json: Cli.Flag.Boolean('json'),
  },
  ({ worktree, json }) => runWorktree('inspect', worktree, flagArgs('json', json)),
).pipe(Cli.Command.withDescription('Inspect attribution as tagged JSON; grants no exclusion'))
const guard = Cli.Command.make(
  'guard',
  {
    gitDir: Cli.Flag.String('git-dir'),
  },
  ({ gitDir }) =>
    Effect.gen(function* () {
      yield* runNative(['guard', '--git-dir', yield* resolveNativePath(gitDir)])
    }),
).pipe(
  Cli.Command.withDescription(
    'Observe conservative reclamation eligibility; grants no lasting fence',
  ),
)
const run = Cli.Command.make(
  'run',
  {
    worktree,
    mode: Cli.Flag.String('mode'),
    attempt: Cli.Flag.Boolean('try'),
    awaitSeconds: optional('await'),
    agent: optional('agent'),
    job: optional('job'),
    json: Cli.Flag.Boolean('json'),
    command,
  },
  ({ worktree, mode, attempt, awaitSeconds, agent, job, json, command }) =>
    runWorktree('run', worktree, [
      '--mode',
      mode,
      ...flagArgs('try', attempt),
      ...optionArgs('await', awaitSeconds),
      ...optionArgs('agent', agent),
      ...optionArgs('job', job),
      ...flagArgs('json', json),
      '--',
      ...command,
    ]),
).pipe(Cli.Command.withDescription('Run a command under a native scoped shared or exclusive lease'))
const reap = Cli.Command.make(
  'reap',
  {
    commonDir: Cli.Flag.String('common-dir'),
    scheduled: Cli.Flag.Boolean('scheduled'),
    command,
  },
  ({ commonDir, scheduled, command }) =>
    Effect.gen(function* () {
      yield* runNative([
        'reap',
        '--common-dir',
        yield* resolveNativePath(commonDir),
        ...flagArgs('scheduled', scheduled),
        '--',
        ...command,
      ])
    }),
).pipe(
  Cli.Command.withDescription(
    'Invoke an archive command for conservatively eligible managed worktrees',
  ),
)

export const worktreeCommand = Cli.Command.make('worktree').pipe(
  Cli.Command.withSubcommands([
    Cli.Command.make('lease').pipe(
      Cli.Command.withSubcommands([create, renew, inspect, guard, run, reap]),
      Cli.Command.withDescription(
        'Native per-worktree leases; JSON streams and child exit codes pass through',
      ),
    ),
  ]),
  Cli.Command.withDescription('Worktree lifecycle operations'),
)
