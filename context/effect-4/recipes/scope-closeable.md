# Pattern: scope-closeable

**Area:** Scope **Kind:** mechanical

## Mapping

`Scope.CloseableScope` is renamed to `Scope.Closeable` in Effect 4:

```ts
// v3
let scope: Scope.CloseableScope

// v4
let scope: Scope.Closeable
```

The beta.102 declaration keeps `Closeable` as an interface extending `Scope`; scope creation and
closing behavior are unchanged by this type rename.

## Verification

Checked against `effect@4.0.0-beta.102` `Scope.ts`, where `Closeable` is declared and
`CloseableScope` is absent.

## Gotchas

- This is only the closeable-scope type rename. It does not change `Scope.make`, finalizer order, or
  the `Scope.close` exit supplied by the caller.
