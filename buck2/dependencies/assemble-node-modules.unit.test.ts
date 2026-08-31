import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assembleNodeModules,
  assemblyManifestSchema,
  type AssemblyManifest,
} from './assemble-node-modules.ts'

const scratchDirectories: string[] = []

const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'pnpm-declared-closure-'))
  scratchDirectories.push(directory)
  return directory
}

const packageTree = (
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): string => {
  const directory = join(root, name)
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(directory, path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, contents)
  }
  return directory
}

const emptyManifest = (): AssemblyManifest => ({
  schema: assemblyManifestSchema,
  packageBins: {},
  packageDependencies: {},
  rootDependencies: {},
  bins: {},
  packageWorkspaceDependencies: {},
  workspacePackageDependencies: {},
  workspaceWorkspaceDependencies: {},
  workspaceBins: {},
  rootWorkspaceDependencies: {},
})

const symlinksUnder = (root: string): readonly string[] => {
  const targets: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink() === true) targets.push(readlinkSync(path))
      else if (entry.isDirectory() === true) visit(path)
    }
  }
  visit(root)
  return targets
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('pnpm declared-closure assembly', () => {
  it('assembles peers, bins, and workspace siblings with hardlinked files and relocatable relative links', async () => {
    const root = scratch()
    const sources = join(root, 'sources')
    const peer = packageTree(sources, 'peer', {
      'package.json': '{"name":"peer","version":"2.0.0"}\n',
      'index.js': 'export const peer = 2\n',
      'peer-bin.js': '#!/usr/bin/env node\n',
    })
    const consumer = packageTree(sources, 'consumer', {
      'package.json': '{"name":"consumer","version":"1.0.0"}\n',
      'bin.js': '#!/usr/bin/env node\n',
      'index.js': 'export { peer } from "peer"\n',
    })
    symlinkSync('index.js', join(consumer, 'entry.js'))
    const workspace = packageTree(sources, 'workspace', {
      'package.json': '{"name":"@fixture/workspace"}\n',
      'index.js': 'export const workspace = true\n',
    })
    const output = join(root, 'node_modules')
    const consumerKey = 'consumer@1.0.0_peer@2.0.0'
    const peerKey = 'peer@2.0.0'

    await assembleNodeModules({
      output,
      packages: [
        { key: consumerKey, name: '@fixture/consumer', source: consumer },
        { key: peerKey, name: 'peer', source: peer },
      ],
      workspaces: [{ key: 'fixture-workspace', source: workspace }],
      manifest: {
        ...emptyManifest(),
        packageDependencies: { [`${consumerKey}\tpeer`]: peerKey },
        packageBins: { [`${consumerKey}\tpeer`]: `${peerKey}\tpeer-bin.js` },
        rootDependencies: { '@fixture/consumer': consumerKey },
        bins: { consumer: `${consumerKey}\tbin.js` },
        workspacePackageDependencies: { 'fixture-workspace\tpeer': peerKey },
        workspaceBins: { 'fixture-workspace\tpeer': `${peerKey}\tpeer-bin.js` },
        rootWorkspaceDependencies: { '@fixture/workspace': 'fixture-workspace' },
      },
    })

    const consumerOutput = join(output, '.pnpm', consumerKey, 'node_modules', '@fixture/consumer')
    const peerOutput = join(output, '.pnpm', peerKey, 'node_modules', 'peer')
    expect(realpathSync(join(output, '@fixture/consumer'))).toBe(realpathSync(consumerOutput))
    expect(realpathSync(join(output, '.pnpm', consumerKey, 'node_modules', 'peer'))).toBe(
      realpathSync(peerOutput),
    )
    expect(realpathSync(join(output, '@fixture/workspace'))).toBe(
      realpathSync(join(output, '.workspace', 'fixture-workspace')),
    )
    expect(realpathSync(join(output, '.bin', 'consumer'))).toBe(
      realpathSync(join(consumerOutput, 'bin.js')),
    )
    expect(realpathSync(join(output, '.pnpm', consumerKey, 'node_modules', '.bin', 'peer'))).toBe(
      realpathSync(join(peerOutput, 'peer-bin.js')),
    )
    expect(
      realpathSync(join(output, '.workspace', 'fixture-workspace', 'node_modules', '.bin', 'peer')),
    ).toBe(realpathSync(join(peerOutput, 'peer-bin.js')))
    expect(realpathSync(join(consumerOutput, 'entry.js'))).toBe(
      realpathSync(join(consumerOutput, 'index.js')),
    )
    expect(lstatSync(join(consumer, 'index.js')).ino).toBe(
      lstatSync(join(consumerOutput, 'index.js')).ino,
    )
    expect(symlinksUnder(output)).not.toHaveLength(0)
    expect(symlinksUnder(output).every((target) => !isAbsolute(target))).toBe(true)

    const relocated = join(root, 'relocated', 'node_modules')
    mkdirSync(join(root, 'relocated'), { recursive: true })
    renameSync(output, relocated)
    expect(readFileSync(join(relocated, '@fixture/consumer', 'index.js'), 'utf8')).toContain(
      'from "peer"',
    )
    expect(realpathSync(join(relocated, '.pnpm', consumerKey, 'node_modules', 'peer'))).toBe(
      realpathSync(join(relocated, '.pnpm', peerKey, 'node_modules', 'peer')),
    )
    expect(symlinksUnder(relocated).every((target) => !isAbsolute(target))).toBe(true)
  })

  it('rejects traversal in generated link metadata and removes the incomplete output', async () => {
    const root = scratch()
    const consumer = packageTree(join(root, 'sources'), 'consumer', { 'bin.js': 'safe\n' })
    const output = join(root, 'node_modules')

    await expect(
      assembleNodeModules({
        output,
        packages: [{ key: 'consumer@1.0.0', name: 'consumer', source: consumer }],
        workspaces: [],
        manifest: {
          ...emptyManifest(),
          bins: { consumer: 'consumer@1.0.0\t../outside' },
        },
      }),
    ).rejects.toThrow('bin executable must be normalized')
    expect(() => lstatSync(output)).toThrow()
  })
})
