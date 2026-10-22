import { describe, expect, it } from 'bun:test'
import { Effect, Stream } from 'effect'

import { DownloadLimitError, makeDownloadBudget, readBoundedBytes } from './buck2-cache-join-download.ts'

describe('streamed artifact download limits', () => {
  it('charges partial failed attempts and stops a retry as soon as the aggregate cap is crossed', async () => {
    const budget = makeDownloadBudget(10)
    let attempts = 0
    let chunksConsumed = 0
    const request = Effect.suspend(() => {
      attempts++
      return readBoundedBytes(
        Stream.concat(
          Stream.make(new Uint8Array(4), new Uint8Array(2)).pipe(
            Stream.tap(() => Effect.sync(() => { chunksConsumed++ })),
          ),
          Stream.fail('transport failed'),
        ),
        8,
        budget,
      )
    })
    const result = await Effect.runPromise(Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* request.pipe(Effect.result)
        if (result._tag === 'Success' || result.failure instanceof DownloadLimitError) return result
      }
      return yield* Effect.die('Expected aggregate limit failure before the third attempt')
    }))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure).toBeInstanceOf(DownloadLimitError)
      expect(result.failure).toMatchObject({ message: expect.stringContaining('Total downloaded byte cap hit') })
    }
    expect(attempts).toBe(2)
    expect(chunksConsumed).toBe(4)
    expect(budget.bytes).toBe(12)
  })

  it('keeps the per-response limit and counts its rejected bytes against the shared budget', async () => {
    const budget = makeDownloadBudget(100)
    const result = await Effect.runPromise(
      readBoundedBytes(Stream.make(new Uint8Array(6)), 5, budget).pipe(Effect.result),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.message).toContain('Response byte cap exceeded')
    expect(budget.bytes).toBe(6)
  })
})
