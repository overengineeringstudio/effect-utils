import * as Cli from '@effect/cli'
import { Console, Effect, Option } from 'effect'

import { EffectPath } from '@overeng/effect-path'

import { readMegarepoConfig } from '../../lib/config.ts'
import { LOCK_FILE_NAME, readLockFile } from '../../lib/lock.ts'
import { checkSourcePolicy, formatSourcePolicyViolation } from '../../lib/source-policy.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

const allOption = Cli.Options.boolean('all').pipe(
  Cli.Options.withDescription('Check member source and lock files in repos/ as well as the root'),
  Cli.Options.withDefault(false),
)

/** Check that the megarepo is structurally valid. */
export const checkCommand = Cli.Command.make(
  'check',
  {
    all: allOption,
    json: jsonOption,
  },
  ({ all, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const rootOpt = yield* findMegarepoRoot(cwd)

      if (Option.isNone(rootOpt) === true) {
        return yield* Effect.fail(new Error('No megarepo config found'))
      }

      const root = rootOpt.value
      const { config } = yield* readMegarepoConfig(root)
      const lockPath = EffectPath.ops.join(root, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME))
      const lockFileOpt = yield* readLockFile(lockPath)

      if (Option.isNone(lockFileOpt) === true) {
        return yield* Effect.fail(
          new Error('megarepo.lock is required for megarepo checks; run `mr lock` first'),
        )
      }

      const sourcePolicy = yield* checkSourcePolicy({
        megarepoRoot: root,
        config,
        lockFile: lockFileOpt.value,
        includeMembers: all,
      })

      const result = {
        checks: [
          {
            name: 'source-policy',
            violations: sourcePolicy.violations,
          },
        ],
        violations: sourcePolicy.violations,
      }

      if (json === true) {
        yield* Console.log(JSON.stringify(result, null, 2))
      } else if (result.violations.length === 0) {
        yield* Console.log('Megarepo checks OK')
      } else {
        yield* Console.error('Megarepo check violations:')
        for (const violation of result.violations) {
          yield* Console.error(`- ${formatSourcePolicyViolation(violation)}`)
        }
      }

      if (result.violations.length > 0) {
        return yield* Effect.fail(
          new Error(`Megarepo checks failed with ${result.violations.length} violation(s)`),
        )
      }
    }),
).pipe(Cli.Command.withDescription('Check that the megarepo is structurally valid'))
