/**
 * Integration tests for the live-process in-use probe (Linux `/proc`).
 *
 * Spawns a REAL holder process with its cwd inside a temp "worktree" directory
 * and asserts {@link readWorktreeInUse} reports it as in-use; moves the holder's
 * cwd out and asserts it reports free. Skipped on hosts without `/proc`.
 *
 * The holder is a child of the vitest runner, so it would be excluded if the
 * probe were called with the runner (or pid 1 — every process descends from
 * init) as `selfPid`. We instead pass `selfPid` = the pid of a SIBLING stand-in
 * process: a sibling is never an ancestor of the holder, so the descendant walk
 * from the holder climbs its PPid chain and never encounters it — the holder
 * stays observable. This faithfully models production, where gc is a separate
 * process tree, not an ancestor of the live session.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { readWorktreeInUse } from './store-inuse.ts'

const hasProc = existsSync('/proc')

/** Spawn a long-lived `sleep` whose cwd is `cwd`; resolve once it is observable. */
const spawnHolder = (cwd: string): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
    child.on('error', reject)
    if (child.pid === undefined) {
      reject(new Error('holder failed to spawn'))
      return
    }
    resolve(child)
  })

/** Poll until `/proc/<pid>/cwd` resolves (the process is scheduled + cwd set). */
const waitForCwd = (pid: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const tick = () => {
      if (existsSync(`/proc/${pid}/cwd`) === true) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`holder pid ${pid} never appeared in /proc`))
        return
      }
      setTimeout(tick, 20)
    }
    tick()
  })

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)))

describe.skipIf(hasProc === false)('store-inuse (integration, /proc)', () => {
  it('reports in-use when a live process holds a descendant as cwd, free once it moves out', async () => {
    const { worktreePath, sibling, holder } = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectory()
        const worktreePath = EffectPath.unsafe.absoluteDir(`${tmp}/refs/heads/feature/x/`)
        const inner = EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeDir('src/'))
        // A sibling that shares the worktree's string prefix — must NOT match.
        const sibling = EffectPath.unsafe.absoluteDir(`${tmp}/refs/heads/feature/x.archive-old/`)
        yield* fs.makeDirectory(inner, { recursive: true })
        yield* fs.makeDirectory(sibling, { recursive: true })
        return { worktreePath, inner, sibling }
      }),
    ).then(async ({ worktreePath, inner, sibling }) => {
      const holder = await spawnHolder(inner)
      await waitForCwd(holder.pid!)
      return { worktreePath, sibling, holder }
    })

    // A SIBLING stand-in (shares the runner as parent, so not an ancestor of the
    // holder) plays the role of the gc process: passing its pid as `selfPid`
    // leaves the holder observable, the way real gc would observe a live session.
    const standIn = await spawnHolder('/')
    const selfPid = standIn.pid!
    try {
      const inUse = await run(readWorktreeInUse({ worktreePath, selfPid }))
      expect(inUse._tag).toBe('in-use')
      if (inUse._tag === 'in-use') {
        expect(inUse.holder.pid).toBe(holder.pid)
        expect(inUse.holder.path.startsWith(worktreePath.replace(/\/$/, ''))).toBe(true)
      }

      // A worktree the holder is NOT inside (the .archive-old sibling) reads free.
      const siblingResult = await run(readWorktreeInUse({ worktreePath: sibling, selfPid }))
      expect(siblingResult._tag).toBe('free')

      // After the holder dies, the worktree reads free.
      holder.kill('SIGKILL')
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()))
      const afterKill = await run(readWorktreeInUse({ worktreePath, selfPid }))
      expect(afterKill._tag).toBe('free')
    } finally {
      holder.kill('SIGKILL')
      standIn.kill('SIGKILL')
    }
  })

  it('excludes the current process so the gc process never self-vetoes', async () => {
    // With selfPid = the spawning runner, the holder (its descendant) is excluded.
    const { worktreePath, holder } = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectory()
        const worktreePath = EffectPath.unsafe.absoluteDir(`${tmp}/wt/`)
        yield* fs.makeDirectory(worktreePath, { recursive: true })
        return { worktreePath }
      }),
    ).then(async ({ worktreePath }) => {
      const holder = await spawnHolder(worktreePath.replace(/\/$/, ''))
      await waitForCwd(holder.pid!)
      return { worktreePath, holder }
    })

    try {
      const result = await run(readWorktreeInUse({ worktreePath, selfPid: process.pid }))
      expect(result._tag).toBe('free')
    } finally {
      holder.kill('SIGKILL')
    }
  })
})
