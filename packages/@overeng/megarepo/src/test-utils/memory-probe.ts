/**
 * Out-of-process memory probe for the `getWorktreeStatus` dirt path.
 *
 * Runs in a FRESH subprocess (spawned by the memory regression test) so the
 * measured peak RSS reflects only this run, not a vitest worker contaminated by
 * earlier tests. `VmHWM` in `/proc/self/status` is the process-lifetime peak
 * resident set, so it MUST be sampled in a dedicated process to discriminate the
 * O(n²)-buffer path from the streaming one.
 *
 * Usage: `bun memory-probe.ts <worktreePath>` — prints a single JSON line
 * `{ "rssStartKb": <number>, "vmHwmKb": <number>, "changesCount": <number> }`.
 *
 * `rssStartKb` is the resident set sampled BEFORE the status call so the test can
 * assert on the per-process growth (`vmHwmKb - rssStartKb`), which is independent
 * of the host/runtime baseline. Reads `VmHWM` from `/proc/self/status` rather
 * than `process.memoryUsage().rss` because RSS is an instantaneous sample that
 * can miss the transient O(n²) allocation peak, while `VmHWM` is the monotonic
 * high-water mark.
 */

import { readFileSync } from 'node:fs'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import * as Git from '../lib/git.ts'
import { encodeJson } from './json.ts'

const readProcKb = (field: 'VmHWM' | 'VmRSS'): number => {
  const status = readFileSync('/proc/self/status', 'utf8')
  const match = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm'))
  if (match?.[1] === undefined) {
    throw new Error(`${field} not found in /proc/self/status (Linux only)`)
  }
  return Number(match[1])
}

const worktreePath = process.argv[2]
if (worktreePath === undefined) {
  console.error('usage: bun memory-probe.ts <worktreePath>')
  process.exit(2)
}

const program = Effect.gen(function* () {
  const rssStartKb = readProcKb('VmRSS')
  const status = yield* Git.getWorktreeStatus(worktreePath)
  const vmHwmKb = readProcKb('VmHWM')
  // eslint-disable-next-line no-console
  console.log(encodeJson({ rssStartKb, vmHwmKb, changesCount: status.changesCount }))
})

Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer))).catch((error) => {
  console.error(error)
  process.exit(1)
})
