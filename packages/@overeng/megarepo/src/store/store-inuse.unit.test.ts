import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { classifyInUse, isPathInsideWorktree, type ProcPath } from './store-inuse.ts'

const WT = '/store/github.com/acme/widget/refs/heads/feature/x'

describe('store-inuse', () => {
  describe('isPathInsideWorktree', () => {
    it('matches the worktree path itself', () => {
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: WT })).toBe(true)
    })

    it('matches a descendant', () => {
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: `${WT}/src/lib` })).toBe(true)
    })

    it('does not match an outside path', () => {
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: '/store/other' })).toBe(false)
    })

    it('does not match a sibling that shares the string prefix (.archive-old)', () => {
      // The `+ '/'` boundary is load-bearing: a raw startsWith would wrongly match.
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: `${WT}.archive-old` })).toBe(false)
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: `${WT}-2` })).toBe(false)
    })

    it('normalizes trailing slashes on both sides', () => {
      expect(isPathInsideWorktree({ worktreePath: `${WT}/`, candidate: WT })).toBe(true)
      expect(isPathInsideWorktree({ worktreePath: WT, candidate: `${WT}/` })).toBe(true)
      expect(isPathInsideWorktree({ worktreePath: `${WT}/`, candidate: `${WT}/src/` })).toBe(true)
    })
  })

  describe('classifyInUse', () => {
    const procPaths = (entries: ReadonlyArray<ProcPath>) => entries

    it('returns none when no process path is inside the worktree', () => {
      const result = classifyInUse({
        worktreePath: WT,
        procPaths: procPaths([
          { pid: 10, path: '/store/other' },
          { pid: 11, path: '/' },
        ]),
        excludePids: new Set(),
      })
      expect(Option.isNone(result)).toBe(true)
    })

    it('returns the first holder whose path is at or under the worktree', () => {
      const result = classifyInUse({
        worktreePath: WT,
        procPaths: procPaths([
          { pid: 10, path: '/elsewhere' },
          { pid: 42, path: `${WT}/src` },
          { pid: 43, path: WT },
        ]),
        excludePids: new Set(),
      })
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value).toEqual({ pid: 42, path: `${WT}/src` })
      }
    })

    it('skips excluded pids (self/descendant) and reports the next holder', () => {
      const result = classifyInUse({
        worktreePath: WT,
        procPaths: procPaths([
          { pid: 42, path: `${WT}/src` },
          { pid: 99, path: `${WT}/docs` },
        ]),
        excludePids: new Set([42]),
      })
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value.pid).toBe(99)
      }
    })

    it('returns none when the only holder is excluded', () => {
      const result = classifyInUse({
        worktreePath: WT,
        procPaths: procPaths([{ pid: 42, path: `${WT}/src` }]),
        excludePids: new Set([42]),
      })
      expect(Option.isNone(result)).toBe(true)
    })

    it('does not flag a sibling .archive-old path as in-use', () => {
      const result = classifyInUse({
        worktreePath: WT,
        procPaths: procPaths([{ pid: 7, path: `${WT}.archive-old/src` }]),
        excludePids: new Set(),
      })
      expect(Option.isNone(result)).toBe(true)
    })
  })
})
