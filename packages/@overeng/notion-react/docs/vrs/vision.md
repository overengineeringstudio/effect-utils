# Vision — @overeng/notion-react

## The Problem

- **Problem 1 — Imperative Notion code is hostile to structured content.** A
  Notion page is a tree of blocks, but every caller ends up writing a flat
  chain of `blocks.append` / `blocks.update` / `blocks.delete` calls. Control
  flow, conditionals, and composition are expressed as imperative mutations
  on the Notion API surface — not as the tree the user is trying to describe.
- **Problem 2 — Full re-writes are the default, and they are wasteful.**
  Without a principled diff between "what is on the page" and "what should be
  on the page", the pragmatic path is to wipe the target page and reappend
  everything on each run. This produces visible churn (cursor jumps, lost
  comments, broken permalinks) and O(blocks) API cost per cycle, even when
  the page barely changed.
- **Problem 3 — Per-project reconcilers accrete complexity.** Every team that
  wants incremental output to Notion ends up hand-rolling a keyed diff, a
  cache schema, and a kill-switch. These implementations diverge, miss edge
  cases (reordering, archived blocks, page-id drift), and have no shared
  testing surface against the real Notion API.
- **Problem 4 — Composition is impossible.** There is no way to factor a
  "session", a "day header", or a "PR list" as a reusable unit with its own
  state, annotations, or children. The lowest common denominator is string
  concatenation plus a manual block-type switch.

## The Vision

- A JSX-first authoring surface where `<Page><Heading1>...</Heading1></Page>`
  is the full description of a Notion page. Block components match Notion
  block types 1:1; inline components compose annotations and links into rich
  text the caller never has to hand-assemble.
- A principled reconciliation step between successive renders so that an
  unchanged tree costs zero Notion API calls, and a one-line change costs a
  single `update`. The same code path covers cold-start (append everything)
  and warm-path (minimum ops), differing only by what is in cache.
- An Effect-native API that any downstream program can compose: the sync
  returns an `Effect` with typed errors and explicit Notion-client
  dependencies. No hidden globals, no ambient fetch.
- A pluggable cache layer so callers choose how the reconciler state is
  persisted (filesystem, in-memory, SQLite, …) without changing how they
  author their pages.
- Components are the unit of reuse. A downstream can ship a library of
  `<DayHeader>`, `<SessionTimeline>`, `<PrTable>` components and compose
  them with props, hooks, and context — the same patterns already familiar
  from React DOM work.

## What This Is Not

- Not a Notion editor. This renders a program's output into a Notion page;
  it does not accept human edits and reconcile them back.
- Not a collaboration surface. No operational transform, no CRDT, no
  presence. Concurrent human edits inside regions the renderer owns will be
  overwritten.
- Not a direct DOM renderer for end users. The companion web renderer exists
  to preview components visually (Storybook, design iteration); it is not a
  production React-DOM target and is not API-stable.
- Not a general-purpose block database ORM. It outputs blocks within a
  single page/container; it does not model databases, queries, or relations.
- Not a "write once, render anywhere" layer. JSX is the input; Notion is the
  output. Other targets (Markdown, HTML) are out of scope for v0.

## Success Criteria

- **S1** An idempotent sync — rendering the same JSX twice against the same
  page produces zero Notion API mutations on the second run.
- **S2** Minimum-op mutations — a single prop change in one block produces
  exactly one `update` call; a single sibling insert produces exactly one
  `append`/`insert` call; a single removal produces exactly one `delete`.
- **S3** A caller whose only dependencies are `react`, `effect`, and this
  library can render a full Notion page — no custom host config, no
  bespoke diff code, no hand-rolled cache.
- **S4** The pixeltrail daily-page sync is migrated onto this library and
  exhibits the same or better op-count as the hand-rolled reconciler it
  replaces.
- **S5** A new block type can be added by writing a component (+ host-config
  projection) in under ~50 lines, without forking the library.
