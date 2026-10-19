import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entrypoint = fileURLToPath(new URL('./buck2-daemon-reaper.ts', import.meta.url))
const runner = fileURLToPath(
  new URL('../packages/@overeng/megarepo/src/store/store-buck-maintain.ts', import.meta.url),
)

describe('Buck maintenance script receipt contract', () => {
  it.each(['clean-failed', 'kill-failed', 'daemon-changed'] as const)(
    'prints the complete receipt before returning the exit status for %s',
    (reason) => {
      const receipt = {
        version: 1,
        dryRun: false,
        entries: [
          {
            worktree: '/fixture/failed',
            action: reason === 'clean-failed' ? 'clean-stale' : 'none',
            reason,
            bytesBefore: 8192,
            bytesAfter: 8192,
            daemon:
              reason === 'kill-failed'
                ? [{ pid: 123, isolation: 'v2', outcome: 'unreachable', reason }]
                : [],
            ownerEvidence: [],
          },
          {
            worktree: '/fixture/later-worktree',
            action: 'none',
            reason: 'within-budget',
            bytesBefore: 8192,
            bytesAfter: 8192,
            daemon: [],
            ownerEvidence: [],
          },
        ],
        summary: {
          worktrees: 2,
          actions: reason === 'clean-failed' ? 1 : 0,
          skipped: reason === 'clean-failed' ? 1 : 2,
        },
      }
      const bootstrap = `
        import { mock } from 'bun:test'
        import { Effect } from ${JSON.stringify(import.meta.resolve('effect'))}
        mock.module(${JSON.stringify(runner)}, () => ({
          runBuckMaintain: () => Effect.succeed(${JSON.stringify(receipt)}),
        }))
        process.argv = ['bun', ${JSON.stringify(entrypoint)}, '--json']
        // Module-loading boundary: install the completed runner fixture before loading the CLI.
        await import(${JSON.stringify(entrypoint)})
      `
      const result = spawnSync(process.execPath, ['--eval', bootstrap], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      })
      expect(result.signal).toBeNull()
      expect(result.status).toBe(reason === 'daemon-changed' ? 0 : 1)
      expect(result.stdout).not.toBe('')
      expect(JSON.parse(result.stdout)).toEqual(receipt)
      if (reason !== 'daemon-changed') expect(result.stderr).toContain('BuckMaintainCommandFailed')
    },
  )
})
