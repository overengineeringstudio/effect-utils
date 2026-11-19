import { isAbsolute } from 'node:path'

import { Console, Effect, Schema } from 'effect'
import * as Cli from 'effect/cli'
import * as ChildProcess from 'effect/process/ChildProcess'

import { parseSourceString, isRemoteSource } from '../../../core/config.ts'
import * as Git from '../../../core/git.ts'
import { preparePoolInstall, runPoolCommand } from '../../../store/store-pool-install.ts'
import { PoolError } from '../../../store/store-pool-state.ts'
import {
  claimPool,
  completePool,
  inspectPool,
  prewarmPool,
  quarantinePool,
  releasePool,
} from '../../../store/store-pool.ts'
import { Store, StoreLayer } from '../../../store/store.ts'

const repository = { repo: Cli.Argument.String('repo') }
const pinned = { ...repository, commit: Cli.Flag.String('commit') }
const resolveRepository = (repo: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    const source = parseSourceString(repo)
    if (source === undefined || isRemoteSource(source) === false)
      return yield* new PoolError({ message: 'Expected a remote repository identity' })
    if ((yield* store.hasBareRepo(source)) === false)
      return yield* new PoolError({ message: 'Repository must already exist in the store' })
    return { store, source, bare: store.getBareRepoPath(source) }
  })
const exactCommit = (commit: string) =>
  /^[0-9a-f]{40}$/u.test(commit) === true
    ? Effect.void
    : Effect.fail(new PoolError({ message: 'Expected a full immutable commit SHA' }))

const prewarm = Cli.Command.make(
  'prewarm',
  {
    ...pinned,
    maxSlots: Cli.Flag.Int('max-slots'),
    maxBytes: Cli.Flag.Int('max-bytes'),
    charge: Cli.Flag.Int('charge-bytes'),
  },
  ({ repo, commit, maxSlots, maxBytes, charge }) =>
    Effect.gen(function* () {
      const { store, bare } = yield* resolveRepository(repo)
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(yield* prewarmPool({ base: store.basePath, bare, commit, maxSlots, maxBytes, charge })),
      )
    }),
).pipe(
  Cli.Command.withDescription('Reserve host-wide capacity and prepare a protected native GVS slot'),
)

const claim = Cli.Command.make(
  'claim',
  {
    identity: Cli.Flag.String('identity'),
    owner: Cli.Flag.String('owner'),
    command: Cli.Argument.String('command').pipe(Cli.Argument.atLeast(1)),
  },
  ({ identity, owner, command }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const slot = yield* claimPool({ base: store.basePath, identity, owner })
      const retain = (reason: string) => quarantinePool({ base: store.basePath, id: slot.id, token: slot.token, reason })
      yield* Console.log(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(slot))
      // The live provider is the activation ancestor for ordinary install/check wrappers.
      const code = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* ChildProcess.make(command[0]!, command.slice(1), {
            cwd: slot.path,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
            env: {
              MR_POOL_SLOT: slot.id,
              MR_POOL_TOKEN: slot.token,
              MR_POOL_GENERATION: String(slot.generation),
            },
          })
          return yield* child.exitCode
        }),
      ).pipe(Effect.tapError((error) => retain(String(error))))
      if (code !== 0) {
        yield* retain(`Task exited ${code}`)
        process.exitCode = code
      }
      if (code === 0) yield* completePool({ base: store.basePath, id: slot.id, token: slot.token, generation: slot.generation })
    }),
).pipe(
  Cli.Command.withDescription(
    'Atomically claim a generation and run its owner command; release explicitly from outside',
  ),
)

const release = Cli.Command.make(
  'release',
  {
    id: Cli.Flag.String('slot'),
    token: Cli.Flag.String('token'),
    generation: Cli.Flag.Int('generation'),
  },
  ({ id, token, generation }) =>
    Effect.gen(function* () {
      const store = yield* Store
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(yield* releasePool({ base: store.basePath, id, token, generation })),
      )
    }),
).pipe(
  Cli.Command.withDescription(
    'Drain and reprepare a clean unchanged generation; retain uncertainty',
  ),
)

const status = Cli.Command.make('status', {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* Console.log(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(yield* inspectPool(store.basePath)))
  }),
)

/** Read-only source access does not allocate a writable checkout or run setup. */
const read = Cli.Command.make(
  'read',
  { ...pinned, file: Cli.Argument.String('file') },
  ({ repo, commit, file }) =>
    Effect.gen(function* () {
      yield* exactCommit(commit)
      const { bare } = yield* resolveRepository(repo)
      yield* Console.log(
        yield* Git.runCommand({
          cwd: bare,
          args: ['show', `${commit}:${file}`],
          env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
        }),
      )
    }),
).pipe(
  Cli.Command.withDescription(
    'Read an immutable Git blob without writable setup or a task worktree',
  ),
)

/** Promotion always allocates the real canonical branch path; slots never become branches. */
const promote = Cli.Command.make(
  'promote',
  { ...pinned, branch: Cli.Flag.String('branch') },
  ({ repo, commit, branch }) =>
    Effect.gen(function* () {
      yield* exactCommit(commit)
      const canonicalMr = process.env.MR_CANONICAL_BIN
      if (canonicalMr === undefined || isAbsolute(canonicalMr) === false)
        return yield* new PoolError({ message: 'Packaged absolute MR_CANONICAL_BIN is required' })
      const { store } = yield* resolveRepository(repo)
      const path = yield* runPoolCommand({ cwd: store.basePath, command: canonicalMr, args: [
        'store',
        'worktree',
        'new',
        repo,
        '--ref',
        branch,
        '--base',
        commit,
        '--no-fetch',
        '--porcelain',
      ] })
      yield* preparePoolInstall(path)
      yield* Console.log(path)
    }),
).pipe(
  Cli.Command.withDescription(
    'Lazily create and install a new canonical branch at the pinned source',
  ),
)

/** Callable native pool lifecycle, pinned reads and canonical edit promotion. */
export const storePoolCommand = Cli.Command.make('pool', {}).pipe(
  Cli.Command.withSubcommands([prewarm, claim, release, status, read, promote]),
  Cli.Command.withDescription('Bounded native detached execution roots and lazy canonical editing'),
  Cli.Command.provide(StoreLayer),
)
