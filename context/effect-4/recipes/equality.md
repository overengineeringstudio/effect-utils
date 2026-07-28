# Pattern: equality

**Area:** Equality and HashSet/HashMap membership  **Kind:** semantic  **Our usage:** direct
`Equal.equals` is low-volume, but equality semantics flow into dedup, cache keys,
set membership, and change detection.

## v3

```ts
Equal.equals({ x: 1 }, { x: 1 }) // false
HashSet.size(HashSet.fromIterable([{ x: 1 }, { x: 1 }])) // 2
```

## v4

```ts
Equal.equals({ x: 1 }, { x: 1 }) // true
HashSet.size(HashSet.fromIterable([{ x: 1 }, { x: 1 }])) // 1
Equal.equals(Equal.byReference({ x: 1 }), { x: 1 }) // false
```

## Equivalence

Command:

```sh
bun run run equality
```

Result: semantic diffs are allowlisted for plain objects, arrays, maps, sets,
dates, regexps, `NaN`, and HashSet membership/dedup outcomes.

## Intended differences (alignment register entries)

- v4 structural equality is useful by default but changes identity-sensitive
  caches and dedup. Proposed decision: accept structural equality unless the site
  is demonstrably identity-sensitive; use `Equal.byReference` or
  `Equal.byReferenceUnsafe` only at those sites.

## Gotchas

- JavaScript `Set`/`Map` still use JS identity semantics; Effect `HashSet` and
  `HashMap` use Effect equality.
- `Equal.byReference` returns a Proxy. The probe records `proxySameReference:
  false`, so code relying on object identity should prefer `byReferenceUnsafe`
  only after checking mutation/ownership risk.
