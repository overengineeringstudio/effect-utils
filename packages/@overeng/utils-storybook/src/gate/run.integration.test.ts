import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { readBaselinePairIdentity } from './run.ts'

// Keep real Git coverage in the required package test lane, but minimize launches:
// four setup commands and seven snapshot commands, with no install or lockfile edits.
// Pair composition and dependency-install selection have separate unit coverage.
describe('readBaselinePairIdentity with Git', () => {
  it('isolates the baseline while including an edited main tree only for borrowed dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'story-gate-identity-'))
    const repoRoot = join(root, 'repo')
    const worktreeDir = join(root, 'baseline')
    const packageRoot = join(repoRoot, 'packages', 'widget')
    const sourceFile = join(packageRoot, 'view.ts')
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()
    try {
      mkdirSync(packageRoot, { recursive: true })
      git('init', '-q')
      writeFileSync(sourceFile, 'original')
      git('add', '.')
      git(
        '-c',
        `core.hooksPath=${join(root, 'hooks')}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Story Gate',
        '-c',
        'user.email=gate@example.test',
        'commit',
        '-qm',
        'initial',
      )
      git('worktree', 'add', '--detach', worktreeDir, 'HEAD')
      writeFileSync(sourceFile, 'edited during capture')

      // Only tracked changes matter here. No lockfile mutation, installs, or
      // repeated before-snapshots: the committed baseline has a known identity.
      const options = { repoRoot, packageRoot, worktreeDir, sourceRoots: [] }
      const independent = readBaselinePairIdentity({ ...options, borrowedDependencies: false })
      const borrowed = readBaselinePairIdentity({ ...options, borrowedDependencies: true })
      expect(independent.entries).toEqual({ HEAD: independent.head })
      expect(independent.digest).toBe(
        createHash('sha1').update(`HEAD=${independent.head}`).digest('hex'),
      )
      expect(borrowed.entries['worktree/HEAD']).toBe(independent.head)
      expect(borrowed.entries['linked/HEAD']).toBe(independent.head)
      expect(Object.keys(borrowed.entries)).toEqual([
        'worktree/HEAD',
        'linked/HEAD',
        'linked/tracked:packages/widget/view.ts',
      ])
      expect(borrowed.entries['linked/tracked:packages/widget/view.ts']).toMatch(/^[a-f0-9]{40}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
