import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'

/** One invocation's diagnostic sink, inherited by its asynchronous publication work. */
export const editorViewDiagnostics = new AsyncLocalStorage<(value: string) => void>()

/** Preserve stderr bytes outside a callable invocation; never mutate process-global streams. */
export const writeEditorViewDiagnostic = (value: string): void => {
  const write = editorViewDiagnostics.getStore()
  if (write === undefined) process.stderr.write(value)
  else write(value)
}
