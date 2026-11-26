import { isDeepStrictEqual } from 'node:util'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  acceptedMovesAreLegal,
  determinism,
  immutability,
  jsonRoundTrip,
  legalMoves,
  replay,
} from './mod.ts'

type State = { total: number }
type Input = { state: State; move: number }

const parameters = { seed: 322, numRuns: 100 }
const state = fc.record({ total: fc.integer({ min: 0, max: 10 }) })
const input = fc.record({ state, move: fc.integer({ min: -2, max: 4 }) })
const apply = ({ state: current, move }: Input): State | undefined =>
  move >= 0 && move <= 3 && current.total + move <= 10
    ? { total: current.total + move }
    : undefined
const moves = (current: State) =>
  [0, 1, 2, 3].filter((move) => current.total + move <= 10)
const accepted = (result: State | undefined) => result !== undefined
const legal = (sample: Input, result: State | undefined) =>
  result !== undefined && moves(sample.state).includes(result.total - sample.state.total)

/** Check both failure detection and fast-check's public seed/path reproduction contract. */
const expectFailure = <TInput>(property: fc.IProperty<[TInput]>) => {
  const failure = fc.check(property, parameters)
  expect(failure.failed).toBe(true)
  expect(failure.counterexample).not.toBeNull()
  if (!failure.failed) return
  const reproduced = fc.check(property, {
    seed: failure.seed,
    path: failure.counterexamplePath,
    numRuns: 1,
    endOnFailure: true,
  })
  expect(reproduced.failed).toBe(true)
  expect(reproduced.counterexample).toEqual(failure.counterexample)
}

describe('caller-owned adapters', () => {
  it('checks deterministic immutable transitions including rejection', () => {
    fc.assert(determinism({ arbitrary: input, run: apply, equal: isDeepStrictEqual }), parameters)
    fc.assert(
      immutability({
        arbitrary: input,
        run: apply,
        snapshot: structuredClone,
        equal: isDeepStrictEqual,
      }),
      parameters,
    )
  })

  it('compares replay with independently accumulated expected state', () => {
    const traces = fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }).map((log) => ({
      log,
      expected: { total: log.reduce((total, move) => total + move, 0) },
    }))
    fc.assert(
      replay({
        arbitrary: traces,
        expected: (trace) => trace.expected,
        replay: (trace) =>
          trace.log.reduce((current, move) => apply({ state: current, move })!, { total: 0 }),
        equal: isDeepStrictEqual,
      }),
      parameters,
    )
  })

  it('round-trips complete states through JSON', () => {
    fc.assert(jsonRoundTrip({ arbitrary: state, equal: isDeepStrictEqual }), parameters)
  })

  it('checks both directions of legal move acceptance', () => {
    fc.assert(
      legalMoves({
        arbitrary: state,
        moves,
        apply: (current, move) => apply({ state: current, move }),
        accepted,
      }),
      parameters,
    )
    fc.assert(acceptedMovesAreLegal({ arbitrary: input, apply, accepted, legal }), parameters)
  })

  it('allows an empty terminal enumeration without asserting nonemptiness', () => {
    fc.assert(
      legalMoves({
        arbitrary: fc.constant({ total: 10 }),
        moves: () => [],
        apply: (current, move: number) => apply({ state: current, move }),
        accepted,
      }),
      parameters,
    )
  })
})

describe('invalid adapters produce reproducible counterexamples', () => {
  it('detects nondeterminism', () => {
    let offset = 0
    expectFailure(
      determinism({
        arbitrary: state,
        run: (current) => ({ total: current.total + (offset++ % 2) }),
        equal: isDeepStrictEqual,
      }),
    )
  })

  it('detects incorrect replay', () => {
    expectFailure(
      replay({
        arbitrary: state,
        expected: (current) => current,
        replay: (current) => ({ total: current.total + 1 }),
        equal: isDeepStrictEqual,
      }),
    )
  })

  it('detects nested input mutation, including configuration', () => {
    expectFailure(
      immutability({
        arbitrary: state.map((current) => ({ state: current, config: { history: [0] } })),
        run: (sample) => sample.config.history.push(1),
        snapshot: structuredClone,
        equal: isDeepStrictEqual,
      }),
    )
  })

  it('detects JSON data loss rather than normalizing it', () => {
    expectFailure(
      jsonRoundTrip({
        arbitrary: state.map((current) => ({ ...current, missing: undefined })),
        equal: isDeepStrictEqual,
      }),
    )
    for (const value of [undefined, Number.NaN, Infinity, -0, 1n])
      expectFailure(jsonRoundTrip({ arbitrary: fc.constant(value), equal: isDeepStrictEqual }))
  })

  it('detects rejection of an enumerated legal move', () => {
    expectFailure(
      legalMoves({ arbitrary: state, moves, apply: () => undefined, accepted }),
    )
  })

  it('detects accepted illegal moves using the resulting canonical move', () => {
    expectFailure(
      acceptedMovesAreLegal({
        arbitrary: input,
        apply: (sample) => ({ total: sample.state.total + 4 }),
        accepted,
        legal,
      }),
    )
  })

  it('does not swallow callback exceptions', () => {
    expectFailure(
      determinism({
        arbitrary: state,
        run: () => JSON.parse('invalid JSON'),
        equal: isDeepStrictEqual,
      }),
    )
  })
})
