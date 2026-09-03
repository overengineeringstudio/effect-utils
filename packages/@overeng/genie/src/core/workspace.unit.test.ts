import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { planPattern, resolveWorkspaceProvider } from './workspace.ts'

const FIXTURE: Record<string, string> = {
  'pnpm-workspace.yaml': [
    'packages:',
    "  - '.'",
    '  - apps/*',
    '  - packages/**',
    '  - legacy/web-*',
    '  - tmp/pruned',
    '  - missing/dir',
    '',
  ].join('\n'),
  'package.json': '{"name":"root"}',
  'apps/a/package.json': '{"name":"a"}',
  // `apps/*` is a single segment, so a manifest one level deeper is not a workspace package.
  'apps/b/nested/package.json': '{"name":"nested"}',
  // A file where a directory listing expects packages.
  'apps/README.md': '# not a package',
  'packages/x/package.json': '{"name":"x"}',
  // Skipped directory names are never traversed, even below a matching pattern.
  'packages/x/node_modules/dep/package.json': '{"name":"dep"}',
  'packages/group/y/package.json': '{"name":"y"}',
  'packages/nomanifest/keep.txt': 'no manifest here',
  'legacy/web-one/package.json': '{"name":"web-one"}',
  'legacy/other/package.json': '{"name":"other"}',
  // Declared, but `tmp` is a skipped directory name.
  'tmp/pruned/package.json': '{"name":"pruned"}',
  'unlisted/package.json': '{"name":"unlisted"}',
}

const withFixture = async (assert: (root: string) => Promise<void>) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-workspace-'))
  try {
    for (const [relativePath, content] of Object.entries(FIXTURE)) {
      const filePath = path.join(root, relativePath)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }
    await assert(await fs.realpath(root))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const discover = async (cwd: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* resolveWorkspaceProvider({ cwd })
      const paths = yield* provider.discoverPackageJsonPaths({ cwd })
      return paths.map((p) => path.relative(cwd, p).replace(/\\/g, '/')).toSorted()
    }).pipe(Effect.provide(NodeServices.layer)),
  )

describe('resolveWorkspaceProvider', () => {
  it('discovers exactly the manifests the pnpm workspace patterns name', async () => {
    vi.stubEnv('GENIE_WORKSPACE_PROVIDER', '')
    await withFixture(async (root) => {
      expect(await discover(root)).toEqual([
        'apps/a/package.json',
        'legacy/web-one/package.json',
        'package.json',
        'packages/group/y/package.json',
        'packages/x/package.json',
      ])
    })
  })

  it('discovers every manifest outside skipped directories without a workspace manifest', async () => {
    vi.stubEnv('GENIE_WORKSPACE_PROVIDER', 'manual')
    await withFixture(async (root) => {
      expect(await discover(root)).toEqual([
        'apps/a/package.json',
        'apps/b/nested/package.json',
        'legacy/other/package.json',
        'legacy/web-one/package.json',
        'package.json',
        'packages/group/y/package.json',
        'packages/x/package.json',
        'unlisted/package.json',
      ])
    })
  })
})

describe('planPattern', () => {
  it('resolves a literal pattern without any directory listing', () => {
    expect(planPattern('packages/@overeng/genie')).toEqual({
      prefix: ['packages', '@overeng', 'genie'],
      levels: 0,
    })
    expect(planPattern('.')).toEqual({ prefix: [], levels: 0 })
  })

  it('lists one level per `*` segment and the whole subtree for `**`', () => {
    expect(planPattern('apps/*')).toEqual({ prefix: ['apps'], levels: 1 })
    expect(planPattern('legacy/web-*')).toEqual({ prefix: ['legacy'], levels: 1 })
    expect(planPattern('apps/*/plugins/*')).toEqual({ prefix: ['apps'], levels: 3 })
    expect(planPattern('packages/**')).toEqual({ prefix: ['packages'], levels: 'any' })
  })

  it('rejects patterns rooted in a skipped directory', () => {
    expect(planPattern('node_modules/pkg')).toBeUndefined()
    expect(planPattern('tmp/pruned')).toBeUndefined()
  })
})
