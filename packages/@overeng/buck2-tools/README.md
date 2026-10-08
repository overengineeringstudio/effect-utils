# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and workspace editor views.

## Editor publisher

`src/editor-view.ts` atomically publishes and checks one dependency view.
`scripts/editor-view-authority.ts` derives the root source-generator consumer and
every package consumer from the canonical workspace registry, proves that Buck
owns each tracked manifest, builds every `:editor_view_inputs` manifest, and
invokes the publisher in deterministic order. Published snapshots byte-own the
finite provider-declared closure; no link points back into disposable
`buck-out`.

`buck2:editor:bootstrap` publishes only the dependency views named by the
committed generated root manifest so `genie:check` can run before trusting the
generated graph. After generation and composition, repository tasks
`buck2:editor:authority`, `buck2:editor:publish`, and `buck2:editor:check`
operate on the complete current registry. The exact-token
`buck2:editor:recover-lock` task recovers only the named consumer's shared
publication lock. These tasks require a real composed megarepo workspace and
are not global check dependencies.

### Retired worktree removal

After closing editors, watchers, and builds using a retired worktree, run
`devenv tasks run buck2:editor:release --mode single` from that worktree. Then
leave its working directory and use ordinary `git worktree remove` from another
worktree. This explicit teardown is not garbage collection: it removes the
worktree's editor roots, including every sibling view sharing those roots.

The publisher CLI also supports `release --repo-root <root> --package <package>`
for one shared editor root. Teardown holds the publication lock, refuses an
existing lock (including a stale one until exact-token recovery), and makes only
owned directories writable before removal. It never follows snapshot symlinks
or changes external dependency targets. Release is never a dependency of setup,
tests, or checks; republishing recreates a released root.

## Test collection

The JavaScript runner loads test modules when collecting their inventory without
executing assertions. Static parsing is opt-in: the runner passes an explicit
negative flag otherwise, rather than relying on the pinned Vitest CLI's default.
This includes cases registered by imported helpers such as rule-test generators.
