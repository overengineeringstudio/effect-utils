import { Exit } from 'effect'
import { describe, expect, it } from 'vitest'

import { editorExitCode } from '@overeng/notion-md'

/**
 * The umbrella `notion` binary wires `editorExitCode` into its `runMain`
 * teardown (see `cli.ts`) so that `notion edit` honors the same scriptable
 * exit-code contract as the standalone `notion-md edit`. These assertions pin
 * that shared mapping: editor-tagged failures get their distinct codes and any
 * other failure falls back to 1 (the framework default), so non-editor umbrella
 * commands are unaffected.
 */
describe('umbrella editor teardown exit codes', () => {
  it('maps editor-tagged failures to their distinct codes', () => {
    expect(editorExitCode(Exit.fail({ _tag: 'NmdRemoteBodyLossyError' }))).toBe(3)
    expect(editorExitCode(Exit.fail({ _tag: 'NmdSchemaDriftError' }))).toBe(6)
    expect(editorExitCode(Exit.fail({ _tag: 'NmdEditorAbortedError' }))).toBe(8)
  })

  it('falls back to 1 for non-editor failures and 0 on success', () => {
    expect(editorExitCode(Exit.fail({ _tag: 'SomeUnmappedError' }))).toBe(1)
    expect(editorExitCode(Exit.fail(new Error('boom')))).toBe(1)
    expect(editorExitCode(Exit.succeed(undefined))).toBe(0)
  })
})
