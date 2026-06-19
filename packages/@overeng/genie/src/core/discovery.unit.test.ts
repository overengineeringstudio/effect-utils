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
      const relative = discovered.map((file) => path.relative(root, file)).toSorted()

      expect(relative).toEqual([
        'tracked/package.json.genie.ts',
        'untracked/tsconfig.json.genie.ts',
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
