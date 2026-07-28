# Pattern: browser-builtin-leakage

**Area:** Browser bundling **Kind:** semantic CI gate **Our usage:** browser entries in
`effect-react`, `notion-react`, `tui-react`, `react-inspector`, and `effect-schema-form*`.

## v3

```ts
export { Schema, TestClock } from 'effect'
```

The representative v3 facade bundles for the browser without resolving a Node builtin.

## v4

```ts
// Runtime facade:
export { Schema } from 'effect'

// Tests import directly; never re-export this from a runtime/browser facade:
import { TestSchema } from 'effect/testing'
```

## Equivalence

```sh
bun run run:pattern browser-builtin-leakage
```

ALLOWLISTED characterization: both runtime facades bundle. The deliberately contaminated v3 facade
also bundles, while v4 is rejected because `effect/testing` reaches `node:assert`.

This must remain a CI gate: bundle every public browser/runtime entry with `platform: "browser"` and
an explicit resolver that fails on every `node:` import. The command must return non-zero on a
forbidden builtin; logging an error while returning success is not a gate.

## Intended differences (alignment register entries)

- v4 testing barrels can be Node-only transitive dependencies — intentional package topology, not
  an application behavior to preserve — keep testing exports out of runtime facades and accept the
  narrower public surface — affects all browser-facing packages.

## Gotchas

- Tree shaking does not make a static re-export safe. The resolver must load the re-exported module
  before it can determine what is unused.
- Typecheck is not evidence for browser compatibility.
- Test helpers should use direct `effect/testing/*` imports in test files; do not expose them from a
  runtime facade for import convenience.
- Gate source/public entry points, not only one hand-written fixture.

## Codemod rule

None. Import relocation in test files is mechanical, but deciding which public re-exports to remove
is an API-boundary change.
