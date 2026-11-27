# @overeng/game-laws

Small synchronous fast-check property builders for caller-owned game adapters.
They return properties, not registered tests: use `fc.assert` or `fc.check` with
any test runner. TypeScript is intentional here: these callbacks adapt existing
TypeScript rules directly to fast-check without an engine or runtime bridge.
The package owns no rules, schemas, random generators, replay protocol, sessions,
seats, or UI. Its only runtime dependency is the caller's fast-check peer
(the workspace uses 4.10.3).

## API and preconditions

Every builder takes one options object containing `arbitrary` and returns
`fc.IProperty<[TInput]>`. Callers own generation, shrinking, run counts, saved
examples, equality, and assertions. Callback exceptions fail the property; they
are never caught, normalized, or treated as discarded samples.

| Builder                 | Other callbacks                             | Assertion                                                             |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `determinism`           | `run`, `equal`                              | Two runs on the same input are equal.                                 |
| `replay`                | `expected`, `replay`, `equal`               | Independently reconstructed and expected states are equal.            |
| `immutability`          | `run`, `snapshot`, `equal`                  | Detached snapshots before and after execution are equal.              |
| `jsonRoundTrip`         | `equal(original, decoded)`                  | Complete value survives JSON stringify/parse. `decoded` is `unknown`. |
| `legalMoves`            | `moves`, `apply(input, move)`, `accepted`   | Every enumerated move is accepted.                                    |
| `acceptedMovesAreLegal` | `apply`, `accepted`, `legal(input, result)` | Every accepted result satisfies caller legality.                      |

`Equal<TValue>` is `(left: TValue, right: TValue) => boolean`. Use complete
structural equality, not reference identity or a lossy projection. Assertions
inside an equality callback may throw for richer diagnostics.

- Determinism requires nonmutating input and independently owned results; a
  callback returning the same mutable object twice can hide nondeterminism.
  Clone inside `run` if the tested operation requires fresh equivalent inputs.
- Replay requires an independent expected result and reconstruction, not two
  aliases of the same implementation/result. The caller owns legal traces,
  rejection policy, and any intermediate-state or undo assertions.
- Immutability needs a detached snapshot. A reference to the original mutable
  object is not a snapshot. Snapshot the whole generated input to cover state,
  move, and config; snapshot only state when that is the existing contract.
  Keep recursive freezing when mutation attempts must fail even if later undone.
- JSON loss is not repaired: undefined, nonfinite numbers, negative zero,
  functions, cycles, and bigint can fail comparison or serialization. Choose
  equality deliberately; do not compare both sides after JSON normalization.
- Legal enumerations may be empty at terminal states. Assert nonterminal
  nonemptiness separately. `accepted` must distinguish rejection from success,
  including any tagged-result conventions. The converse receives the output so
  callers can check a canonicalized move rather than the original submitted move.
- Use fresh generated mutable samples when testing mutation. A mutable singleton
  supplied by `fc.constant` can contaminate subsequent runs and shrinking.

These laws do not replace domain assertions such as conservation, scoring,
termination, wrong-seat rejection, valid schema membership, or exact notation.

## Existing game adapters

The following replacements use the existing local helpers from
`schickling/schickling.dev` game tests. No rule changes are needed. Shared imports
and equality in each test module:

```ts
import * as Laws from '@overeng/game-laws'

const equal = <TValue>(left: TValue, right: unknown): boolean => {
  expect(left).toEqual(right)
  return true
}
```

### Chess: complete replay and JSON equality

Inside the existing 60-second playout test, retain 120 plies and 10 runs:

```ts
const playouts = fc.tuple(fc.integer(), fc.boolean()).map(([seed, timed]) => {
  const config = timed ? blitz : untimed
  return { config, ...randomPlayout({ seed, plies: 120, config }) }
})
fc.assert(
  Laws.replay({
    arbitrary: playouts,
    expected: ({ state }) => {
      expect(JSON.parse(JSON.stringify(state))).toEqual(state)
      return state
    },
    replay: ({ config, moves }) => replay({ config, moves }),
    equal,
  }),
  { numRuns: 10 },
)
```

Keep all PGN field-specific assertions, malformed-input properties, clocks and
other domain examples. `jsonRoundTrip` can also be asserted separately over a
caller-owned state arbitrary when a separate law/test is desired.

### Wizard: seeded deals and source immutability

Replace only the existing seeded-deal property's wrapper. Keep card uniqueness,
deterministic initial state, the original seed/player ranges, and 40 runs:

```ts
const deals = fc
  .tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 3, max: 6 }))
  .map(([seed, players]) => {
    const cfg = { ...config, seed, players }
    return { cfg, state: initialState(cfg) }
  })
fc.assert(
  Laws.immutability({
    arbitrary: deals,
    snapshot: ({ state }) => JSON.stringify(state),
    run: ({ cfg, state }) => {
      expect(initialState(cfg)).toEqual(state)
      expect(
        new Set([...Object.values(state.hands).flat(), state.trumpCard!].map((card) => card.id))
          .size,
      ).toBe(cfg.players + 1)
      finishRound({ original: state, cfg })
    },
    equal: (before, after) => before === after,
  }),
  { numRuns: 40 },
)
```

`finishRound` retains its existing acceptance assertions and iteration bound.

### Azul (formerly Tiles): every legal move applies

The original Tiles test now lives under `src/games/azul/rules.test.ts`.
Retain the exhaustive outer state loop, freezing, and wrong-seat checks.
Each constant property runs once, examining every enumerated move:

```ts
for (const state of states) {
  deepFreeze(state)
  const seat = actors(state)[0]!
  fc.assert(
    Laws.legalMoves({
      arbitrary: fc.constant(state),
      moves: (state) => legalMoves({ state, seat }),
      apply: (state, move) => {
        const next = tryApply(state, seat, move)
        for (const other of ['p1', 'p2', 'p3', 'p4'].filter((x) => !actors(state).includes(x)))
          expect(tryApply(state, other, move)).toBeUndefined()
        return next
      },
      accepted: (next) => next !== undefined,
    }),
    { numRuns: 1 },
  )
}
```

Keep the near-valid-move test's canonical `next.lastMove.move` membership,
acting-seat and tile-count assertions; its converse can use
`acceptedMovesAreLegal`. Keep full playout termination and conservation checks.
In older Tiles tests, also retain saved stalemate counterexamples, replay
equality, undo/RNG restoration, alternate-seed distinction and JSON equality.

Platform replay tests can similarly adapt their independently reduced applied
moves to `replay`. Automerge convergence projections, merge order and protocol
semantics remain entirely downstream.

## Tests and reproduction

`src/mod.unit.test.ts` exercises valid immutable transition adapters and broken
adapters for each law, including nested configuration mutation, JSON data loss,
exceptions and canonicalized illegal output. Failure tests use seed `322`,
assert a counterexample, then reproduce it through fast-check's returned
`seed` and `counterexamplePath`; they do not suppress failed laws.

After workspace registration, the declared test task is
`devenv tasks run test:game-laws`; Buck owns the package's TypeScript and test
admission through `BUCK.genie.ts`. Generate manifests and Buck projections with
`devenv tasks run genie:run`. No validation results are implied by these commands.
