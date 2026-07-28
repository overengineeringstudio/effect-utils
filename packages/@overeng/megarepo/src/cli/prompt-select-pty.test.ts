import { fileURLToPath } from 'node:url'

import { Effect, Schedule } from 'effect'
import { describe, expect, it } from 'vitest'

import { makePtySession, PtySpec_ } from '@overeng/pty-effect'

type PromptCase = {
  readonly id: 'select' | 'interrupt'
  readonly readiness: string
  readonly inputs: ReadonlyArray<string>
}

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

type PtyResult = {
  readonly readinessObserved: boolean
  readonly trace: PromptTrace
}

const fixturePath = fileURLToPath(new URL('./prompt-select-pty-fixture.ts', import.meta.url))
const traceMarker = 'TRACE:'
const readinessTimeoutMillis = 5_000
const inputDelayMillis = 90
const pollSchedule = Schedule.spaced('20 millis')

const runPromptCase = (testCase: PromptCase): Promise<PtyResult> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makePtySession(
          PtySpec_.spawn({
            command: process.execPath,
            args: [fixturePath, testCase.id],
            size: { rows: 24, cols: 80 },
          }),
        )

        const readiness = yield* session
          .waitForText({ needle: testCase.readiness, schedule: pollSchedule })
          .pipe(
            Effect.timeoutFail({
              duration: readinessTimeoutMillis,
              onTimeout: () =>
                new Error(
                  `PTY prompt did not reach visible readiness string ${JSON.stringify(testCase.readiness)}`,
                ),
            }),
          )

        for (const input of testCase.inputs) {
          yield* session.write({ data: input })
          yield* Effect.sleep(inputDelayMillis)
        }

        const completed = yield* session
          .waitForText({ needle: traceMarker, schedule: pollSchedule })
          .pipe(
            Effect.timeoutFail({
              duration: readinessTimeoutMillis,
              onTimeout: () => new Error(`PTY prompt did not emit a structured trace`),
            }),
          )
        const markerIndex = completed.text.indexOf(traceMarker)
        const encodedTrace = completed.text
          .slice(markerIndex + traceMarker.length)
          .replaceAll(/\s/g, '')
        const trace = JSON.parse(Buffer.from(encodedTrace, 'base64').toString('utf8')) as PromptTrace

        return {
          readinessObserved: readiness.text.includes(testCase.readiness),
          trace,
        }
      }),
    ),
  )

describe('Prompt.select real-PTY semantics', () => {
  it('selects the second value and restores cooked mode', async () => {
    const result = await runPromptCase({
      id: 'select',
      readiness: 'Choose missing-ref action',
      inputs: ['\u001b[B', '\r'],
    })

    expect(result).toEqual({
      readinessObserved: true,
      trace: { case: 'select', result: 'skip', rawAfter: false },
    })
  })

  it('classifies Ctrl-C as Quit and restores cooked mode', async () => {
    const result = await runPromptCase({
      id: 'interrupt',
      readiness: 'Abort missing-ref action',
      inputs: ['\u0003'],
    })

    expect(result).toEqual({
      readinessObserved: true,
      trace: { case: 'interrupt', exit: 'Quit', rawAfter: false },
    })
  })
})
