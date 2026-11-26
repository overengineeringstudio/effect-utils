import fc from 'fast-check'

/** Compare complete observable values, not object identity. Assertions may throw. */
export type Equal<TValue> = (left: TValue, right: TValue) => boolean

/** Requires a callback that neither mutates input nor reuses a mutable result. */
export const determinism = <TInput, TValue>(options: {
  readonly arbitrary: fc.Arbitrary<TInput>
  readonly run: (input: TInput) => TValue
  readonly equal: Equal<TValue>
}): fc.IProperty<[TInput]> =>
  fc.property(options.arbitrary, (input) => options.equal(options.run(input), options.run(input)))

/** Compare a caller-owned expected state with an independent reconstruction. */
export const replay = <TInput, TState>(options: {
  readonly arbitrary: fc.Arbitrary<TInput>
  readonly expected: (input: TInput) => TState
  readonly replay: (input: TInput) => TState
  readonly equal: Equal<TState>
}): fc.IProperty<[TInput]> =>
  fc.property(options.arbitrary, (input) =>
    options.equal(options.expected(input), options.replay(input)),
  )

/** Snapshot must be detached and cover every input whose mutation matters. */
export const immutability = <TInput, TSnapshot>(options: {
  readonly arbitrary: fc.Arbitrary<TInput>
  readonly run: (input: TInput) => unknown
  readonly snapshot: (input: TInput) => TSnapshot
  readonly equal: Equal<TSnapshot>
}): fc.IProperty<[TInput]> =>
  fc.property(options.arbitrary, (input) => {
    const before = options.snapshot(input)
    options.run(input)
    return options.equal(before, options.snapshot(input))
  })

/** JSON failures propagate; parsed JSON is untrusted and is never cast to TValue. */
export const jsonRoundTrip = <TValue>(options: {
  readonly arbitrary: fc.Arbitrary<TValue>
  readonly equal: (original: TValue, decoded: unknown) => boolean
}): fc.IProperty<[TValue]> =>
  fc.property(options.arbitrary, (value) => options.equal(value, JSON.parse(JSON.stringify(value))))

/** Every enumerated legal move applies. Nonterminal nonemptiness is a separate law. */
export const legalMoves = <TInput, TMove, TResult>(options: {
  readonly arbitrary: fc.Arbitrary<TInput>
  readonly moves: (input: TInput) => readonly TMove[]
  readonly apply: (input: TInput, move: TMove) => TResult
  readonly accepted: (result: TResult) => boolean
}): fc.IProperty<[TInput]> =>
  fc.property(options.arbitrary, (input) =>
    options.moves(input).every((move) => options.accepted(options.apply(input, move))),
  )

/** The converse: accepted moves are legal, including any canonicalized output. */
export const acceptedMovesAreLegal = <TInput, TResult>(options: {
  readonly arbitrary: fc.Arbitrary<TInput>
  readonly apply: (input: TInput) => TResult
  readonly accepted: (result: TResult) => boolean
  readonly legal: (input: TInput, result: TResult) => boolean
}): fc.IProperty<[TInput]> =>
  fc.property(options.arbitrary, (input) => {
    const result = options.apply(input)
    return !options.accepted(result) || options.legal(input, result)
  })
