# Pattern: effect-sequencing

**Area:** Effect sequencing **Kind:** rename **Our usage:** 70 workspace compiler diagnostics for
`Effect.zipRight` on the current flip snapshot.

## v3

```ts
acquire.pipe(Effect.zipRight(use))
```

## v4

```ts
acquire.pipe(Effect.andThen(use))
```

`Effect.zipRight` is absent at beta.102. `Effect.andThen` is its direct replacement when the
right-hand operand is an `Effect`: run the left effect first, discard its success value, then run
and return the right effect.

## Equivalence

The replacement is **VERIFIED** against the real `effect@3.21.4` and
`effect@4.0.0-beta.102` tarballs. A direct cross-major probe established that both forms:

- evaluated the left effect before the right effect;
- returned the right effect's success value;
- did not evaluate the right effect when the left effect failed.

The declaration signatures also preserve the union of both error channels and both service
requirements.

## Intended differences

None.

## Gotchas

- V4 `andThen` also accepts plain values and lazy values. Preserve an effectful right-hand operand
  as an `Effect`; do not unwrap it into an eager computation.
- This is sequential composition. Do not replace `zipRight` with a concurrent combinator.
- Keep any existing `Effect.uninterruptibleMask`, scope, or transaction boundary around the whole
  composition. Moving the boundary between the two effects changes interruption behavior.

## Codemod rule

`Effect.zipRight(left, right)` becomes `Effect.andThen(left, right)`, and
`left.pipe(Effect.zipRight(right))` becomes `left.pipe(Effect.andThen(right))`.
