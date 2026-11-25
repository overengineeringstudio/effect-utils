import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  computeProductRev,
  readProductRev,
  readWorkingClosure,
  syncProductRevs,
} from './product-revs.js'

let root = ''
let member = ''
let clock = 1_700_000_000

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `@${clock} +0000`,
      GIT_COMMITTER_DATE: `@${clock} +0000`,
    },
  }).trim()

/** Write files and commit them with a strictly increasing, deterministic committer time. */
const commit = (cwd: string, files: Record<string, string>, message = 'change') => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  clock += 60
  run(cwd, 'add', '-A')
  run(
    cwd,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  )
  return run(cwd, 'rev-parse', 'HEAD')
}

const pinMember = (commitSha: string) =>
  JSON.stringify({ version: 1, members: { lib: { url: member, commit: commitSha } } })

const sourcePaths = ['apps/game', 'packages/shared', 'repos/lib/packages/core']
const project = () => computeProductRev({ root, product: 'apps/game', sourcePaths })

beforeEach(() => {
  clock = 1_700_000_000
  root = realpathSync(mkdtempSync(join(tmpdir(), 'product-revs-')))
  member = join(root, 'repos/lib')
  mkdirSync(member, { recursive: true })
  run(member, 'init', '--quiet')
  run(root, 'init', '--quiet')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('keeps the revision across unrelated and projection-only commits and advances on closure changes', async () => {
  const memberA = commit(member, { 'packages/core/index.js': 'a\n', 'packages/cli/x.js': '1\n' })
  const producer = commit(root, {
    '.gitignore': 'repos/\n',
    'apps/game/main.ts': 'v1\n',
    'packages/shared/index.ts': 's1\n',
    'apps/other/main.ts': 'o1\n',
    'megarepo.lock': pinMember(memberA),
  })
  const first = await project()
  expect(first).toMatchObject({ rev: producer, commitTs: clock, product: 'apps/game' })

  commit(root, { 'docs/readme.md': 'docs\n', 'apps/other/main.ts': 'o2\n' }, 'unrelated')
  commit(root, { 'product-revs/game.json': 'generated\n' }, 'refresh product revs')
  // A member bump that leaves the declared member paths untouched keeps the revision.
  const memberB = commit(member, { 'packages/cli/x.js': '2\n' })
  commit(root, { 'megarepo.lock': pinMember(memberB) }, 'repin unrelated member change')
  expect(await project()).toEqual(first)

  const gameChange = commit(root, { 'apps/game/main.ts': 'v2\n' }, 'game source')
  const second = await project()
  expect(second.rev).toBe(gameChange)
  expect(second.closureDigest).not.toBe(first.closureDigest)

  const memberC = commit(member, { 'packages/core/index.js': 'c\n' })
  const memberChange = commit(root, { 'megarepo.lock': pinMember(memberC) }, 'repin core change')
  expect((await project()).rev).toBe(memberChange)
})

it('reports Git stderr when Git exits without reading stdin', async () => {
  const missingRoot = join(root, 'missing')
  await expect(
    computeProductRev({ root: missingRoot, product: 'apps/game', sourcePaths }),
  ).rejects.toThrow(/fatal: cannot change to .*missing.*No such file or directory/)
})

it('selects the original producer after a revert and ignores merges inheriting a parent', async () => {
  const memberA = commit(member, { 'packages/core/index.js': 'a\n' })
  const original = commit(root, {
    '.gitignore': 'repos/\n',
    'apps/game/main.ts': 'v1\n',
    'packages/shared/index.ts': 's1\n',
    'megarepo.lock': pinMember(memberA),
  })
  commit(root, { 'apps/game/main.ts': 'v2\n' })
  commit(root, { 'apps/game/main.ts': 'v1\n' }, 'revert')
  expect((await project()).rev).toBe(original)

  const main = run(root, 'rev-parse', 'HEAD')
  run(root, 'checkout', '--quiet', '-b', 'side')
  commit(root, { 'docs/side.md': 'side\n' })
  run(root, 'checkout', '--quiet', main)
  commit(root, { 'docs/main.md': 'main\n' })
  clock += 60
  run(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'merge',
    '--quiet',
    '--no-ff',
    '-m',
    'merge',
    'side',
  )
  expect((await project()).rev).toBe(original)
})

it('refreshes, checks, and reports working-tree closure state', async () => {
  const memberA = commit(member, { 'packages/core/index.js': 'a\n' })
  commit(root, {
    '.gitignore': 'repos/\n',
    'apps/game/main.ts': 'v1\n',
    'packages/shared/index.ts': 's1\n',
    'megarepo.lock': pinMember(memberA),
  })
  const products = [{ product: 'apps/game', sourcePaths, output: 'product-revs/game.json' }]
  expect(await syncProductRevs({ root, mode: 'check', products })).toEqual([
    expect.stringContaining('is missing'),
  ])
  await syncProductRevs({ root, mode: 'refresh', products })
  commit(root, {}, 'refresh product revs')
  expect(await syncProductRevs({ root, mode: 'check', products })).toEqual([])
  const projection = await readProductRev(join(root, 'product-revs/game.json'))
  expect(readFileSync(join(root, 'product-revs/game.json'), 'utf8')).toContain('"$comment"')

  const clean = await readWorkingClosure({ root, sourcePaths: projection.sourcePaths })
  expect(clean).toEqual({ closureDigest: projection.closureDigest, uncommitted: false })
  writeFileSync(join(root, 'apps/game/main.ts'), 'edited\n')
  expect((await readWorkingClosure({ root, sourcePaths })).uncommitted).toBe(true)
  commit(root, {}, 'game edit')
  // A committed closure change without refresh is stale, both to the gate and to the digest.
  expect((await readWorkingClosure({ root, sourcePaths })).closureDigest).not.toBe(
    projection.closureDigest,
  )
  expect(await syncProductRevs({ root, mode: 'check', products })).toEqual([
    expect.stringContaining('is stale'),
  ])
})

it('refuses shallow history', async () => {
  const memberA = commit(member, { 'packages/core/index.js': 'a\n' })
  commit(root, {
    '.gitignore': 'repos/\n',
    'apps/game/main.ts': 'v1\n',
    'packages/shared/index.ts': 's1\n',
    'megarepo.lock': pinMember(memberA),
  })
  commit(root, { 'apps/game/main.ts': 'v2\n' })
  const shallow = join(root, 'shallow')
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${root}`, shallow])
  await expect(
    computeProductRev({
      root: shallow,
      product: 'apps/game',
      sourcePaths,
      memberCheckout: () => member,
    }),
  ).rejects.toThrow(/full Git history/)
})
