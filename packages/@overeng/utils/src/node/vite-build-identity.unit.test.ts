import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { readWorktreeGitMetadata } from './vite-build-identity.js'

const revision = '1234567890abcdef1234567890abcdef12345678'
const otherRevision = 'abcdef1234567890abcdef1234567890abcdef12'

it('resolves linked-worktree HEAD and index separately from the common branch ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identity-git-linked-'))
  try {
    const common = join(root, 'main/.git')
    const gitDir = join(common, 'worktrees/linked')
    const linked = join(root, 'linked')
    mkdirSync(join(common, 'refs/heads/nested'), { recursive: true })
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(join(linked, 'app'), { recursive: true })
    writeFileSync(join(common, 'config'), '[core]\nrepositoryformatversion = 0\n')
    writeFileSync(join(linked, '.git'), 'gitdir: ../main/.git/worktrees/linked\n')
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/nested/branch\n')
    writeFileSync(join(common, 'refs/heads/nested/branch'), `${revision}\n`)
    writeFileSync(join(common, 'HEAD'), `ref: refs/heads/main\n`)
    writeFileSync(join(common, 'refs/heads/main'), `${otherRevision}\n`)
    const subscribed: string[] = []
    const result = await readWorktreeGitMetadata({
      root: join(linked, 'app'),
      subscribe: (path) => subscribed.push(path),
    })
    expect(result.rev).toBe(revision)
    expect(result.paths).toEqual(
      new Set([
        join(gitDir, 'HEAD'),
        join(gitDir, 'index'),
        join(common, 'refs/heads/nested/branch'),
      ]),
    )
    expect(subscribed).toEqual([...result.paths])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads packed refs and gives a subsequently-created loose ref precedence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identity-git-packed-'))
  try {
    const gitDir = join(root, '.git')
    mkdirSync(join(gitDir, 'refs/heads'), { recursive: true })
    writeFileSync(join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\n')
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(
      join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${otherRevision} refs/heads/main-other\n${revision} refs/heads/main\n^${otherRevision}\n`,
    )
    const packed = await readWorktreeGitMetadata({ root })
    expect(packed.rev).toBe(revision)
    expect(packed.paths).toContain(join(gitDir, 'refs/heads/main'))
    expect(packed.paths).toContain(join(gitDir, 'packed-refs'))
    writeFileSync(join(gitDir, 'refs/heads/main'), `${otherRevision}\n`)
    const loose = await readWorktreeGitMetadata({ root })
    expect(loose.rev).toBe(otherRevision)
    expect(loose.paths).not.toContain(join(gitDir, 'packed-refs'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads a detached HEAD with a readable loose object without resolving any branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identity-git-detached-'))
  try {
    const gitDir = join(root, '.git')
    mkdirSync(join(gitDir, 'objects', revision.slice(0, 2)), { recursive: true })
    writeFileSync(join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\n')
    writeFileSync(join(gitDir, 'HEAD'), `${revision}\n`)
    writeFileSync(
      join(gitDir, 'objects', revision.slice(0, 2), revision.slice(2)),
      'object fixture',
    )
    const result = await readWorktreeGitMetadata({ root })
    expect(result.rev).toBe(revision)
    expect(result.paths).toEqual(new Set([join(gitDir, 'HEAD'), join(gitDir, 'index')]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
