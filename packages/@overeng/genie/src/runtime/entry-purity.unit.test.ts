/**
 * Purity guard for the `@overeng/genie` (`.`) entry.
 *
 * `.` (`./runtime/mod.ts`) is the isomorphic entry: a TYPECHECKING consumer (e.g. a `.bzl`-generating genie
 * user compiling its own source in a strict TS project) imports genie's builders/types — `GenieOutput`/`Strict`
 * and the builder factories — WITHOUT being forced to add `lib:DOM` / `types:node,bun`. That guarantee only
 * holds while the *whole* `.` barrel's import closure stays free of `node:*`/Bun/DOM ambient usage. Filesystem
 * and spawn impurity is injected via `GenieContext` (`io`, `actionlint`) by the engine and re-exported from the
 * `@overeng/genie/node` entry instead.
 *
 * This test compiles `mod.ts` (the entire `.` barrel) with the TypeScript compiler API under the same pure
 * config the real consumer uses (`lib.es2024`, no `node`/`bun` types, no DOM). `skipLibCheck: true` matches the
 * consumer — it lets `import ts from 'typescript'` resolve to its `.d.ts` without node types, while still
 * flagging any `node:*`/Bun/DOM ambient usage in genie's own `.ts` source. Any regression (e.g. a `.`-exported
 * module gaining a `node:fs` import) surfaces as a diagnostic and fails here, in effect-utils, rather than only
 * downstream in a source consumer.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const modPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mod.ts')

describe('@overeng/genie (.) entry purity', () => {
  it('mod.ts typechecks under a pure ES2024 config (no node/Bun/DOM ambient globals)', () => {
    const program = ts.createProgram([modPath], {
      lib: ['lib.es2024.d.ts'],
      types: [],
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(diagnostics, diagnostics.join('\n')).toEqual([])
  }, 30_000)
})
