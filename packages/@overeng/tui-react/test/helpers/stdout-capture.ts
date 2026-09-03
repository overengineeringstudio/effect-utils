/**
 * Capture helpers for the stdout **data channel**.
 *
 * Result/JSON/NDJSON payloads are written straight to fd 1 by
 * `writeStdoutSync`, deliberately below `console.log` and
 * `process.stdout.write`, so a non-zero `process.exit` cannot truncate them
 * (see `src/effect/stdout.node.ts` for the full rationale). Patching the
 * process-global surfaces therefore no longer observes them, and there is no
 * in-process way to redirect a real fd — so tests intercept the writer itself.
 *
 * Byte-level flush behavior is covered separately by the subprocess suite in
 * `test/integration/stdout-drain.test.ts`.
 *
 * @module
 */

import { vi } from 'vitest'

import * as stdoutModule from '../../src/effect/stdout.node.ts'

/** Undo an active capture, restoring the real writers. */
export type RestoreStdoutCapture = () => void

/**
 * Route the data channel into `sink` as newline-stripped lines.
 *
 * Drop-in replacement for the `console.log = (msg) => sink.push(msg)` pattern:
 * one entry per emitted line, no trailing newline.
 */
export const captureStdoutLines = (sink: string[]): RestoreStdoutCapture => {
  const push = (text: string): void => {
    for (const line of text.split('\n')) {
      if (line.length > 0) sink.push(line)
    }
  }
  // Both exports are spied: `writeStdoutLineSync` calls `writeStdoutSync`
  // through a module-local binding, which a namespace spy does not intercept.
  const lineSpy = vi.spyOn(stdoutModule, 'writeStdoutLineSync').mockImplementation(push)
  const rawSpy = vi.spyOn(stdoutModule, 'writeStdoutSync').mockImplementation(push)
  return () => {
    lineSpy.mockRestore()
    rawSpy.mockRestore()
  }
}

/**
 * Route the data channel into `sink` verbatim, newlines included.
 *
 * Drop-in replacement for the `process.stdout.write = (chunk) => sink.push(...)`
 * pattern, for tests asserting exact bytes via `sink.join('')`.
 */
export const captureStdoutRaw = (sink: string[]): RestoreStdoutCapture => {
  const lineSpy = vi
    .spyOn(stdoutModule, 'writeStdoutLineSync')
    .mockImplementation((text: string) => {
      sink.push(`${text}\n`)
    })
  const rawSpy = vi.spyOn(stdoutModule, 'writeStdoutSync').mockImplementation((text: string) => {
    sink.push(text)
  })
  return () => {
    lineSpy.mockRestore()
    rawSpy.mockRestore()
  }
}
