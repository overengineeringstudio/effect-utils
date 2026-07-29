# Pattern: atom-reactivity

**Area:** Reactivity / React bindings **Kind:** mechanical package move with one identifier rename
**Our usage:** 40 `@effect-atom/atom` declarations in 39 files across seven package areas, plus two
`@effect-atom/atom-react` declarations.

## v3

```ts
import { Atom, Registry } from '@effect-atom/atom'
import {
  RegistryContext,
  RegistryProvider,
  useAtom,
  useAtomInitialValues,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomSuspense,
  useAtomValue,
} from '@effect-atom/atom-react'
```

## v4

```ts
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'
import {
  RegistryContext,
  RegistryProvider,
  useAtom,
  useAtomInitialValues,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomSubscribe,
  useAtomSuspense,
  useAtomValue,
} from '@effect/atom-react'
```

The exact package mappings for the beta.102 cohort are:

```text
@effect-atom/atom       -> effect/unstable/reactivity   (Atom stays Atom; Registry -> AtomRegistry)
@effect-atom/atom-react -> @effect/atom-react@4.0.0-beta.102
```

## The one trap: `Registry` becomes `AtomRegistry`

**This is not a pure module-specifier rewrite.** Effect 4's reactivity barrel exports the namespace
`AtomRegistry`, not `Registry`. Every value-level `Registry` import must therefore be renamed:

```ts
import { Registry } from '@effect-atom/atom'
const registry = Registry.make()
```

becomes:

```ts
import { AtomRegistry } from 'effect/unstable/reactivity'
const registry = AtomRegistry.make()
```

`Atom` keeps its name. The React binding names used in this repository also keep their names.

## Why the old packages have no v4 release

Do not wait for or request Effect 4 releases under the old `@effect-atom/*` scope. The library moved
into Effect itself:

- the core Atom implementation is part of `effect/unstable/reactivity`;
- the React bindings moved to `@effect/atom-react` in the Effect monorepo.

The upstream maintainer states the core move directly in
[tim-smart/effect-atom#413](https://github.com/tim-smart/effect-atom/issues/413#issuecomment-3981495009).

The real `effect@4.0.0-beta.102` package tarball declares `./unstable/reactivity` as an export. Its
reactivity barrel carries `Atom`, `AtomRef`, `AtomRegistry`, `AtomRpc`, `AtomHttpApi`,
`AsyncResult`, `Hydration`, and `Reactivity`.

The real `@effect/atom-react@4.0.0-beta.102` package is cohort-aligned: it peers on
`effect ^4.0.0-beta.102` and `react ^19.2.4`. This repository's React catalog version, `19.2.7`,
satisfies that peer. Its declarations export all ten React symbols used here.

## Affected file inventory

The inventory below includes import and re-export declarations. Catalog entries, comments,
fixtures that merely contain package-name text, and dependency declarations are not counted.

| Area              | Files and imported surface                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context/opentui` | `examples/effect-atoms-keyboard.tsx` — `Atom`, `Registry`, `RegistryContext`, `useAtomValue`                                                                                                                                                                                                                                                                                                        |
| `genie`           | `src/build/view.tsx` — type `Atom`                                                                                                                                                                                                                                                                                                                                                                  |
| `megarepo`        | `src/cli/renderers/{AddOutput,DepsOutput,EnvOutput,ExecOutput,GenerateOutput,InitOutput,LsOutput,PinOutput,PushRefsOutput,RootOutput,StatusOutput,StoreOutput,SyncOutput}/view.tsx` — type `Atom`                                                                                                                                                                                                   |
| `notion-cli`      | `src/renderers/{DiffOutput,GenerateConfigOutput,GenerateOutput,InfoOutput,IntrospectOutput}/view.tsx` — type `Atom`                                                                                                                                                                                                                                                                                 |
| `notion-md`       | `src/stories/CliOutput.stories.tsx` — type `Atom`                                                                                                                                                                                                                                                                                                                                                   |
| `tui-react`       | `examples/{01-basic,02-effect-integration,04-stress-tests,05-advanced}/view.tsx`, `examples/03-cli/deploy/view.tsx`, `examples/06-log-capture/view.tsx` — `Atom`; `examples/viewport-overflow-stress.tsx` — type `Atom`; `src/effect/hooks.tsx` — `Atom` plus all ten React re-exports; `src/effect/testing.tsx`, `src/effect/TuiApp.tsx`, `src/storybook/TuiStoryPreview.tsx` — `Atom`, `Registry` |
| `tui-stories`     | `src/cli/renderers/{InspectOutput,ListOutput,RenderOutput}/view.tsx`, `src/StoryCapture.ts` — type `Atom`; `src/cli/renderers/RenderOutput/stories/_megarepo-renders.ts` — `Atom`; `src/cli/renderers/RenderOutput/stories/_render-helper.ts` — type `Atom`, value `Registry`; `src/StoryRenderer.ts` — `Atom`, `Registry`                                                                          |

The complete React binding surface is:

```text
RegistryContext
RegistryProvider
useAtom
useAtomInitialValues
useAtomMount
useAtomRefresh
useAtomSet
useAtomSubscribe
useAtomSuspense
useAtomValue
```

## Catalog action

At `genie/external.ts:369-370`:

1. remove `@effect-atom/atom`;
2. remove `@effect-atom/atom-react`;
3. add `@effect/atom-react` at the same version as the Effect cohort
   (`4.0.0-beta.102` for this migration).

Do not add a separate catalog entry for core Atom. It is supplied by the existing `effect`
dependency through the declared `effect/unstable/reactivity` export.

Regenerate package manifests and the lockfile after the catalog and import migrations are applied.

## Intended differences (alignment register entries)

None. This is an upstream package/module consolidation. Preserve the current atom and React hook
behavior.

## Gotchas

- `Registry` -> `AtomRegistry` is the only identifier rename in the observed import surface and the
  only part that is not a specifier swap.
- Do not retain the Effect-3-only `@effect-atom/atom` package alongside Effect 4. Version `0.5.3`
  peers on `effect ^3.19.15` and imports Effect 3 modules removed by Effect 4.
- Do not retain `@effect-atom/atom-react@0.5.0`. It peers on `effect ^3.19` and depends on the old
  Atom package.
- Do not invent local React bindings. The cohort-matched `@effect/atom-react` successor contains
  every binding used by this repository.
- Migrate dependency declarations as well as source imports. Several packages expose these
  dependencies through generated manifests or peer dependencies.

## Codemod rule

The specifier moves and `Registry` identifier rename are mechanical:

```text
from "@effect-atom/atom"
-> from "effect/unstable/reactivity"

Registry
-> AtomRegistry

from "@effect-atom/atom-react"
-> from "@effect/atom-react"
```

Limit the identifier rename to bindings imported from `@effect-atom/atom`; do not globally rename
unrelated application registries.
