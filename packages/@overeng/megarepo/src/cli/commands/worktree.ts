import { isAbsolute } from 'node:path'

import { Effect, Option } from 'effect'
import * as Cli from 'effect/cli'
import * as ChildProcess from 'effect/process/ChildProcess'

import { Cwd } from '../context.ts'

const worktreeArg = Cli.Argument.String('worktree').pipe(
  Cli.Argument.withDescription('Worktree or subdirectory, resolved by native Git'),
)
const optional = (name: string) => Cli.Flag.String(name).pipe(Cli.Flag.optional)
const optionArgs = ({ name, value }: { name: string; value: Option.Option<string> }) =>
  Option.isSome(value) === true ? [`--${name}`, value.value] : []
const flagArgs = ({ name, enabled }: { name: string; enabled: boolean }) =>
  enabled === true ? [`--${name}`] : []
const commandArg = Cli.Argument.String('command').pipe(
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
  process.exitCode = yield* child.exitCode
})
const resolveNativePath = Effect.fn('worktree.lease.path')(function* (path: string) {
  const cwd = yield* Cwd
  // Do not collapse symlink/.. components before native physical identity resolution.
  return isAbsolute(path) === true ? path : `${cwd}${path}`
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
    worktree: worktreeArg,
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
    worktree: worktreeArg,
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
      ...optionArgs({ name: 'agent', value: agent }),
    ]),
).pipe(Cli.Command.withDescription('Renew attribution through a native shared scope'))
const inspect = Cli.Command.make(
  'inspect',
  {
    worktree: worktreeArg,
    json: Cli.Flag.Boolean('json'),
  },
  ({ worktree, json }) =>
    runWorktree('inspect', worktree, flagArgs({ name: 'json', enabled: json })),
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
    worktree: worktreeArg,
    mode: Cli.Flag.String('mode'),
    attempt: Cli.Flag.Boolean('try'),
    awaitSeconds: optional('await'),
    agent: optional('agent'),
    job: optional('job'),
    json: Cli.Flag.Boolean('json'),
    command: commandArg,
  },
  ({ worktree, mode, attempt, awaitSeconds, agent, job, json, command }) =>
    runWorktree('run', worktree, [
      '--mode',
      mode,
      ...flagArgs({ name: 'try', enabled: attempt }),
      ...optionArgs({ name: 'await', value: awaitSeconds }),
      ...optionArgs({ name: 'agent', value: agent }),
      ...optionArgs({ name: 'job', value: job }),
      ...flagArgs({ name: 'json', enabled: json }),
      '--',
      ...command,
    ]),
).pipe(Cli.Command.withDescription('Run a command under a native scoped shared or exclusive lease'))
const reap = Cli.Command.make(
  'reap',
  {
    commonDir: Cli.Flag.String('common-dir'),
    scheduled: Cli.Flag.Boolean('scheduled'),
    command: commandArg,
  },
  ({ commonDir, scheduled, command }) =>
    Effect.gen(function* () {
      yield* runNative([
        'reap',
        '--common-dir',
        yield* resolveNativePath(commonDir),
        ...flagArgs({ name: 'scheduled', enabled: scheduled }),
        '--',
        ...command,
      ])
    }),
).pipe(Cli.Command.withDescription('Run an archive command for eligible managed worktrees'))

/** Native worktree lease commands with transparent argument and exit-code forwarding. */
export const worktreeCommand = Cli.Command.make('worktree').pipe(
  Cli.Command.withSubcommands([
    Cli.Command.make('lease').pipe(
      Cli.Command.withSubcommands([create, renew, inspect, guard, run, reap]),
      Cli.Command.withDescription('Native leases; JSON streams and exit codes pass through'),
    ),
  ]),
  Cli.Command.withDescription('Worktree lifecycle operations'),
)
