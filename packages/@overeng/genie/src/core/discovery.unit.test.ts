import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { findGenieFiles } from './discovery.ts'

const writeFile = async ({ content, filePath }: { content: string; filePath: string }) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

const toCanonicalRelative = async ({
  files,
  root,
}: {
  files: ReadonlyArray<string>
  root: string
}) => {
  const rootRealPath = await fs.realpath(root)
  return files
    .map((file) =>
      path.relative(rootRealPath, path.resolve(rootRealPath, file)).replace(/\\/g, '/'),
    )
    .toSorted()
}

describe('findGenieFiles', () => {
  it('uses git ignore rules for repository discovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-discovery-'))

    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
      await writeFile({ filePath: path.join(root, '.gitignore'), content: '.claude/\n' })
      await writeFile({
        filePath: path.join(root, 'tracked', 'package.json.genie.ts'),
        content: 'export default {}\n',
      })
      await writeFile({
        filePath: path.join(root, 'untracked', 'tsconfig.json.genie.ts'),
        content: 'export default {}\n',
      })
      await writeFile({
        filePath: path.join(root, '.claude', 'worktrees', 'stale', 'package.json.genie.ts'),
        content: 'throw new Error("ignored local worktree should not be discovered")\n',
      })
      execFileSync('git', ['add', '.gitignore', 'tracked/package.json.genie.ts'], {
        cwd: root,
        stdio: 'ignore',
      })

      const discovered = await Effect.runPromise(
        findGenieFiles(root).pipe(Effect.provide(NodeContext.layer)),
      )
      const relative = await toCanonicalRelative({ root, files: discovered })

      expect(relative).toEqual([
        'tracked/package.json.genie.ts',
        'untracked/tsconfig.json.genie.ts',
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('discovers tracked genie files inside checked-out git submodules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-discovery-'))
    const submoduleSource = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-submodule-'))

    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
      execFileSync('git', ['init'], { cwd: submoduleSource, stdio: 'ignore' })
      await writeFile({
        filePath: path.join(submoduleSource, 'package.json.genie.ts'),
        content: 'export default {}\n',
      })
      execFileSync('git', ['add', 'package.json.genie.ts'], {
        cwd: submoduleSource,
        stdio: 'ignore',
      })
      execFileSync(
        'git',
        [
          '-c',
          'user.email=261620128+schickling-assistant@users.noreply.github.com',
          '-c',
          'user.name=schickling-assistant',
          '-c',
          'commit.gpgsign=true',
          '-c',
          'gpg.format=ssh',
          '-c',
          'gpg.ssh.program=/definitely/missing/signer',
          'commit',
          '--no-gpg-sign',
          '-m',
          'add genie source',
        ],
        { cwd: submoduleSource, stdio: 'ignore' },
      )
      execFileSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/genie'],
        { cwd: root, stdio: 'ignore' },
      )

      const discovered = await Effect.runPromise(
        findGenieFiles(root).pipe(Effect.provide(NodeContext.layer)),
      )
      const relative = await toCanonicalRelative({ root, files: discovered })

      expect(relative).toEqual(['vendor/genie/package.json.genie.ts'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(submoduleSource, { recursive: true, force: true })
    }
  })

  it('returns repo-relative paths when the root is addressed through a symlink', async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-discovery-'))
    const symlinkRoot = `${realRoot}-link`

    try {
      await fs.symlink(realRoot, symlinkRoot, 'dir')
      await writeFile({
        filePath: path.join(realRoot, 'package.json.genie.ts'),
        content: 'export default {}\n',
      })

      const discovered = await Effect.runPromise(
        findGenieFiles(symlinkRoot).pipe(Effect.provide(NodeContext.layer)),
      )
      const relative = await toCanonicalRelative({ root: symlinkRoot, files: discovered })

      expect(discovered).toEqual(['package.json.genie.ts'])
      expect(relative).toEqual(['package.json.genie.ts'])
    } finally {
      await fs.rm(symlinkRoot, { recursive: true, force: true })
      await fs.rm(realRoot, { recursive: true, force: true })
    }
  })
})
