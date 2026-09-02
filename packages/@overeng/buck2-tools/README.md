# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and the scoped editor view.

## Scoped editor publisher

`src/editor-view.ts` publishes and checks the tui-core editor dependency view.
It consumes the built Buck `:editor_inputs` and `:node_modules` artifacts,
uses immutable Nix `cp -al` and GNU `mv --exchange --no-copy`, and retains all
published snapshots and any exchanged root-install directory. Repository tasks
`buck2:tui-core:publish-editor`, `buck2:tui-core:check-editor`, and the
exact-token `buck2:tui-core:recover-editor-lock` are scoped and are not wired
into global checks.
