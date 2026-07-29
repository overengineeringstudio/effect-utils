import { Prompt } from '@effect/cli'
import { NodeContext } from '@effect/platform-node'
import type { QuitException } from '@effect/platform/Terminal'
import { Effect } from 'effect'

type PromptTrace =
  | {
      readonly case: 'select'
      readonly result: 'create' | 'skip' | 'abort'
      readonly rawAfter: boolean
    }
  | {
      readonly case: 'interrupt'
      readonly exit: 'Quit' | 'UnexpectedSelection'
      readonly rawAfter: boolean
    }

const isRaw = () => Boolean((process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw)

const prompt = (message: string) =>
  Prompt.select<'create' | 'skip' | 'abort'>({
    message,
    choices: [
      { title: 'Create branch', value: 'create' },
      { title: 'Skip this member', value: 'skip' },
      { title: 'Abort sync', value: 'abort' },
    ],
  })

const run = (caseId: string): Effect.Effect<PromptTrace, QuitException, never> =>
  caseId === 'select'
    ? Prompt.run(prompt('Choose missing-ref action')).pipe(
        Effect.map((result) => ({ case: 'select', result, rawAfter: isRaw() }) as const),
        Effect.provide(NodeContext.layer),
      )
    : Prompt.run(prompt('Abort missing-ref action')).pipe(
        Effect.map(
          () =>
            ({
              case: 'interrupt',
              exit: 'UnexpectedSelection',
              rawAfter: isRaw(),
            }) as const,
        ),
        Effect.catchTag('QuitException', () =>
          Effect.succeed({ case: 'interrupt', exit: 'Quit', rawAfter: isRaw() } as const),
        ),
        Effect.provide(NodeContext.layer),
      )

const trace: PromptTrace = await Effect.runPromise(run(process.argv[2] ?? ''))
process.stdout.write(`TRACE:${Buffer.from(JSON.stringify(trace)).toString('base64')}`)
