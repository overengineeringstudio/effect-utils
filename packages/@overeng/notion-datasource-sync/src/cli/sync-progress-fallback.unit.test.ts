import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { runWithCliSyncProgress } from './main.ts'
import type { CliCommand } from './main.ts'

/**
 * Regression guard for the packaged-Node `.tsx` import defect.
 *
 * `runWithCliSyncProgress` optionally loads the TUI progress UI via dynamic
 * `import('@overeng/tui-react')`. `@overeng/tui-react` is a `.tsx` module; under
 * a runtime that cannot strip JSX (plain packaged Node) that import REJECTS,
 * which `Effect.promise` surfaces as a **defect** (die), not a typed failure.
 *
 * The bug: the fallback used `Effect.either`, which does NOT catch defects, so a
 * failed load bypassed `runWithPlainSyncProgress` and the command died with zero
 * output (exit 1). The fix promotes the defect onto the error channel before
 * `Effect.either`, so any load failure cleanly degrades to plain progress.
 *
 * This test injects a loader that reproduces the real failure mode — a rejected
 * dynamic import via `Effect.promise` (a die) — and asserts the command still
 * completes AND observably ran plain progress (it writes phase lines to stderr).
 * No network, no real `.tsx` transpile (vitest transpiles `.tsx` fine, so the
 * real import cannot fail here — injecting the raw dying loader is what exercises
 * the defect path). Deleting the `catchAllDefect` line in `main.ts` makes this
 * test crash, confirming it is a genuine RED guard.
 */
describe('runWithCliSyncProgress TUI-load fallback', () => {
  const originalWrite = process.stderr.write.bind(process.stderr)

  afterEach(() => {
    process.stderr.write = originalWrite
  })

  // Reproduce the packaged-Node failure: a rejected dynamic import surfaced by
  // `Effect.promise` as a defect (die), NOT a typed failure. Injecting past the
  // fix (e.g. `Effect.fail`) would prove nothing — the whole point is the defect.
  const dyingTuiLoader = Effect.promise(() =>
    Promise.reject(new Error('Node cannot strip JSX from @overeng/tui-react (.tsx)')),
  ) as ReturnType<typeof Effect.succeed<never>>

  it('falls back to plain progress when the TUI import dies (defect), instead of crashing', async () => {
    const command: CliCommand = { _tag: 'doctor' }

    const captured: Array<string> = []
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write

    const result = await Effect.runPromise(
      runWithCliSyncProgress({
        command,
        effect: Effect.succeed('command-ran'),
        loadTui: dyingTuiLoader,
      }),
    )

    process.stderr.write = originalWrite

    // The command's own effect still ran and produced its value...
    expect(result).toBe('command-ran')
    // ...and the fallback observably used PLAIN progress (stderr phase lines),
    // not the TUI, and did not crash on the load defect.
    expect(captured.join('')).toContain('notion db doctor complete 100%')
  })
})
