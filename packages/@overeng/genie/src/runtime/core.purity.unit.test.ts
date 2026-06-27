/**
 * Purity guard for the `@overeng/genie/core` entry (added alongside the export; effect-utils#854).
 *
 * `./core` exists so a TYPECHECKING consumer (e.g. a `.bzl`-generating genie user that compiles its own
 * source in a strict TS project) can import the core types — `GenieOutput`/`Strict` and their closure — as a
 * clean leaf, WITHOUT resolving genie's runtime source (`node:fs`/Bun/`Response`) and its ambient globals
 * into its own program. That guarantee only holds while `core.ts`'s source import-closure stays free of
 * node/Bun/DOM. This test compiles `core.ts` under a pure ES2024 config (no `node`/`bun` types, no `DOM`
 * lib) via the TypeScript compiler API; a regression — e.g. `core.ts` (or anything it transitively imports)
 * gaining a `node:fs` import — surfaces as a diagnostic and fails here, in effect-utils, rather than only
 * downstream in a source consumer.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const coreFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core.ts')

describe('@overeng/genie/core entry purity', () => {
  it('core.ts typechecks under a pure ES2024 config (no node/Bun/DOM ambient globals)', () => {
    const program = ts.createProgram([coreFile], {
      lib: ['lib.es2024.d.ts'],
      types: [],
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      skipLibCheck: false,
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(diagnostics, diagnostics.join('\n')).toEqual([])
  })
})
