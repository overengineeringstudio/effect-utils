import { Effect, Schema, Stream } from 'effect'

export class DownloadLimitError extends Schema.TaggedError<DownloadLimitError>()('DownloadLimitError', {
  message: Schema.String,
}) {}

export type DownloadBudget = {
  readonly bytes: number
  charge: (size: number) => Effect.Effect<void, DownloadLimitError>
}

/** One shared, monotonic budget: failed response attempts never refund received bytes. */
export const makeDownloadBudget = (limit: number): DownloadBudget => {
  let bytes = 0
  return {
    get bytes() { return bytes },
    charge: (size: number) => Effect.suspend(() => {
      bytes += size
      return bytes > limit
        ? Effect.fail(new DownloadLimitError({ message: `Total downloaded byte cap hit (${limit})` }))
        : Effect.void
    }),
  }
}

export const readBoundedBytes = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  budget?: DownloadBudget,
) => Effect.gen(function* () {
  const chunks: Uint8Array[] = []
  let size = 0
  yield* stream.pipe(Stream.runForEach((chunk) => Effect.gen(function* () {
    // Charge first, including the chunk that crosses either safety bound.
    if (budget !== undefined) yield* budget.charge(chunk.length)
    size += chunk.length
    if (size > maxBytes)
      return yield* new DownloadLimitError({ message: `Response byte cap exceeded (${maxBytes})` })
    chunks.push(chunk)
  })))
  return Buffer.concat(chunks, size)
})
