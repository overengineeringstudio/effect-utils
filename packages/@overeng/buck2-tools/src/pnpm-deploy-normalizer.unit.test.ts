import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  normalizePnpmDeploy,
  PnpmDeployNormalizationError,
  runPnpmDeployNormalizerCli,
} from './pnpm-deploy-normalizer.ts'

const fixtureDirectory = fileURLToPath(
  new URL('./fixtures/pnpm-deploy-normalizer/', import.meta.url),
)
const observedPrefix = '/tmp/effect-utils-pnpm-normalizer-evidence'
const scratchDirectories: string[] = []

const copyFixture = ({
  name,
  destination,
  replacePrefix,
}: {
  readonly name: string
  readonly destination: string
  readonly replacePrefix?: string
}) => {
  mkdirSync(dirname(destination), { recursive: true })
  if (replacePrefix === undefined) {
    copyFileSync(join(fixtureDirectory, name), destination)
  } else {
    writeFileSync(
      destination,
      readFileSync(join(fixtureDirectory, name), 'utf8').replaceAll(observedPrefix, replacePrefix),
    )
  }
}

const createDeployFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'pnpm-deploy-normalizer-'))
  scratchDirectories.push(root)
  const tree = join(root, 'deploy')
  const nodeModules = join(tree, 'node_modules')
  mkdirSync(join(nodeModules, '.pnpm', 'present', 'node_modules', 'present'), { recursive: true })

  copyFixture({
    name: 'modules.observed.json',
    destination: join(nodeModules, '.modules.yaml'),
  })
  copyFixture({
    name: 'tsc-shim.observed.sh',
    destination: join(nodeModules, '.bin', 'tsc'),
    replacePrefix: root,
  })
  copyFixture({
    name: 'workspace-state.observed.json',
    destination: join(nodeModules, '.pnpm-workspace-state-v1.json'),
    replacePrefix: root,
  })
  copyFixture({
    name: 'root-lock.observed.yaml',
    destination: join(tree, 'pnpm-lock.yaml'),
    replacePrefix: root,
  })
  writeFileSync(join(nodeModules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9.0\n')
  symlinkSync('.pnpm/present/node_modules/present', join(nodeModules, 'present'))
  symlinkSync('.pnpm/missing/node_modules/optional-native', join(nodeModules, 'optional-native'))

  return { root, tree, nodeModules }
}

const treeDigest = (root: string) => {
  const hash = createHash('sha256')
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const path = join(directory, entry.name)
      const relativePath = path.slice(root.length + 1)
      if (entry.isDirectory() === true) {
        hash.update(`d ${relativePath}\n`)
        visit(path)
      } else if (entry.isSymbolicLink() === true) {
        hash.update(`l ${relativePath} ${readlinkSync(path)}\n`)
      } else if (entry.isFile() === true) {
        hash.update(`f ${relativePath} `)
        hash.update(readFileSync(path))
      }
    }
  }
  visit(root)
  return hash.digest('hex')
}

const normalizationErrorCode = (thunk: () => unknown) => {
  try {
    thunk()
    return undefined
  } catch (error) {
    return error instanceof PnpmDeployNormalizationError ? error.code : undefined
  }
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('pnpm deploy normalizer', () => {
  it('applies the observed pnpm 11.8.0 transforms deterministically and idempotently', () => {
    const fixture = createDeployFixture()

    const first = normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root })

    expect(first).toEqual({
      removedPrunedAt: true,
      removedStoreDir: true,
      deletedMetadataFiles: 3,
      rewrittenShims: 1,
      prunedDanglingSymlinks: 1,
    })
    const normalizedModulesMetadata = readFileSync(
      join(fixture.nodeModules, '.modules.yaml'),
      'utf8',
    )
    const expectedModulesMetadata: unknown = JSON.parse(
      readFileSync(join(fixtureDirectory, 'modules.normalized.json'), 'utf8'),
    )
    expect(normalizedModulesMetadata).toBe(
      `${JSON.stringify(expectedModulesMetadata, undefined, 2)}\n`,
    )
    expect(normalizedModulesMetadata).not.toContain('storeDir')
    expect(readFileSync(join(fixture.nodeModules, '.bin', 'tsc'), 'utf8')).toContain(
      'export NODE_PATH="$basedir/../.pnpm/typescript@6.0.3',
    )
    expect(readFileSync(join(fixture.nodeModules, '.bin', 'tsc'), 'utf8')).not.toContain(
      fixture.root,
    )
    expect(() => lstatSync(join(fixture.nodeModules, '.pnpm', 'lock.yaml'))).toThrow()
    expect(() => lstatSync(join(fixture.nodeModules, '.pnpm-workspace-state-v1.json'))).toThrow()
    expect(() => lstatSync(join(fixture.tree, 'pnpm-lock.yaml'))).toThrow()
    expect(() => lstatSync(join(fixture.nodeModules, 'optional-native'))).toThrow()
    expect(lstatSync(join(fixture.nodeModules, 'present')).isSymbolicLink()).toBe(true)

    const digestAfterFirstRun = treeDigest(fixture.tree)
    expect(normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root })).toEqual({
      removedPrunedAt: false,
      removedStoreDir: false,
      deletedMetadataFiles: 0,
      rewrittenShims: 0,
      prunedDanglingSymlinks: 0,
    })
    expect(treeDigest(fixture.tree)).toBe(digestAfterFirstRun)
  })

  it('accepts the required CLI argument contract', () => {
    const fixture = createDeployFixture()

    runPnpmDeployNormalizerCli(['--tree', fixture.tree, '--stage-prefix', fixture.root])

    expect(readFileSync(join(fixture.nodeModules, '.bin', 'tsc'), 'utf8')).not.toContain(
      fixture.root,
    )
  })

  it('fails closed when a stage prefix survives a known transform', () => {
    const fixture = createDeployFixture()
    writeFileSync(join(fixture.tree, 'unexpected-metadata.txt'), `source=${fixture.root}/stage\n`)

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root }),
      ),
    ).toBe('residual-absolute-prefix')
  })

  it('fails closed when a dangling symlink remains outside node_modules', () => {
    const fixture = createDeployFixture()
    symlinkSync('missing-output', join(fixture.tree, 'unexpected-link'))

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root }),
      ),
    ).toBe('unsafe-symlink')
  })

  it('rejects an existing absolute symlink target even when it points inside the tree', () => {
    const fixture = createDeployFixture()
    const target = join(fixture.nodeModules, '.pnpm', 'present', 'node_modules', 'present')
    symlinkSync(target, join(fixture.nodeModules, 'absolute-target'))

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root }),
      ),
    ).toBe('unsafe-symlink')
  })

  it('rejects a relative symlink target that escapes the output tree', () => {
    const fixture = createDeployFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'relative-escape'))

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root }),
      ),
    ).toBe('unsafe-symlink')
  })

  it('rejects a chained relative symlink that resolves outside the output tree', () => {
    const fixture = createDeployFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'redirect'))
    symlinkSync('redirect', join(fixture.nodeModules, 'chained-escape'))

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({ tree: fixture.tree, stagePrefix: fixture.root }),
      ),
    ).toBe('unsafe-symlink')
  })

  it('rejects any configured store or worktree prefix that survives normalization', () => {
    const fixture = createDeployFixture()
    const storePrefix = join(fixture.root, 'pnpm-store')
    writeFileSync(join(fixture.tree, 'unexpected-store-path.txt'), `store=${storePrefix}/v11\n`)

    expect(
      normalizationErrorCode(() =>
        normalizePnpmDeploy({
          tree: fixture.tree,
          stagePrefix: fixture.root,
          forbiddenPrefixes: [storePrefix],
        }),
      ),
    ).toBe('residual-absolute-prefix')
  })
})
