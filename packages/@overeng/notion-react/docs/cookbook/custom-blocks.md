# Cookbook — Custom blocks

The library ships 1:1 components for every non-deprecated Notion block
type. When you need to emit a block whose ergonomic wrapper doesn't
exist yet — or a Notion-internal type the library has no opinion on —
reach for `<Raw>`.

## The `<Raw>` escape hatch

`<Raw type content />` emits an arbitrary Notion block. The `content`
prop is forwarded verbatim as the block's type-tagged payload:

```tsx
import { Raw } from '@overeng/notion-react'

<Raw
  type="synced_block"
  content={{
    synced_from: null,
    children: [
      { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Source.' } }] } },
    ],
  }}
/>
```

This produces:

```json
{ "object": "block", "type": "synced_block", "synced_block": { "synced_from": null, "children": [ ... ] } }
```

The library will not validate the payload shape — that's on you.
`<Raw>` is the trap door, not a feature surface.

## Passthrough wrappers

Five thin wrappers exist for block types the library supports but
hasn't grown an ergonomic API for yet. They all forward to `<Raw>`
internally:

| Wrapper         | Block type       | Use when                                   |
| --------------- | ---------------- | ------------------------------------------ |
| `<Template>`    | `template`       | Emitting a template placeholder            |
| `<LinkPreview>` | `link_preview`   | Embedding a link-preview card              |
| `<SyncedBlock>` | `synced_block`   | Creating or referencing a synced block     |
| `<ChildDatabase>` | `child_database` | Emitting a database-as-child reference   |
| `<Breadcrumb>`  | `breadcrumb`     | Rendering a breadcrumb block               |

Each accepts `content: unknown` and forwards it to `<Raw>`.

## Wrapping your own ergonomic component

If you use a custom shape often, write a component that converts your
call-site-friendly props into the raw Notion payload:

```tsx
import { Raw } from '@overeng/notion-react'

type CallbackCalloutProps = {
  readonly label: string
  readonly url: string
}

/** A Notion link_preview pointing at a GitHub PR, say. */
export const PRPreview = ({ label, url }: CallbackCalloutProps) => (
  <Raw
    type="link_preview"
    content={{ url }}
  />
)
```

This keeps call sites clean without committing the library to a
first-class API for the block.

## First-class support

If you find yourself wrapping `<Raw>` for the same block type
repeatedly, first-class support is cheap — roughly 50 LoC per block:

1. Add the block type to `TEXT_LEAF` in `src/renderer/host-config.ts`
   if its JSX children project to `rich_text[]`, otherwise leave it
   out so children reconcile as nested blocks.
2. Extend `blockProps` in the same file with the projection from your
   component's prop shape to Notion's payload shape.
3. Add the prop type to `src/components/props.ts`.
4. Add the component to `src/components/blocks.tsx` (Notion host) and
   its DOM mirror to `src/web/blocks.tsx` (shared prop shape enforces
   parity).
5. Add an e2e test under
   `src/test/integration/e2e/blocks.e2e.test.tsx`.

See the v0.2 additions in [`feat(notion-react): v0.2 block coverage
additions (#77)`](https://github.com/overengineeringstudio/effect-utils/pull/77)
for a worked example.

## See also

- [Concepts → Reconciler](../concepts/reconciler.md) — how your block
  props reach Notion.
- [Internals → Architecture](../internals/architecture.md) — where
  each concern lives in the source tree.
- [`src/components/blocks.tsx`](../../src/components/blocks.tsx) —
  every shipped block component as a reference.
