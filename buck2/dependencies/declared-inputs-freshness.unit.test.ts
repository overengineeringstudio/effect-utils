import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Effect } from 'effect'

import { checkFreshness, type FreshnessManifest } from './declared-inputs-freshness.ts'
import { generatePnpmSha256Sidecar, translatePnpmLock } from './pnpm-lock.ts'

const roots: string[] = []
afterEach(async () => {
  delete process.env.EFFECT_UTILS_PNPM_OFFLINE
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const sources = [
  'genie/buck2/mod.ts',
  'genie/native-dependency-policy.ts',
  'packages/@overeng/genie/src/runtime/core.ts',
  'packages/@overeng/genie/src/runtime/node/inputs.ts',
  'packages/@overeng/genie/src/runtime/node/input-observations.ts',
  'packages/@overeng/genie/src/runtime/repo-context/mod.ts',
  ...['BUCK.genie', 'generate', 'generate-sidecar', 'pnpm-lock', 'pnpm-store', 'pnpm-store-buck', 'public-archive-origin'].map((name) => `buck2/dependencies/${name}.ts`),
]

const fixture = async () => {
  const repo = resolve(import.meta.dir, '../..')
  const temporary = join(repo, 'tmp/declared-inputs-freshness')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'case-'))
  roots.push(root)
  for (const path of sources) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await copyFile(join(repo, path), join(root, path))
  }
  const archive = new TextEncoder().encode('fixture package archive')
  const lockfileText = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true
importers:
  .:
    dependencies:
      fixture:
        specifier: 1.0.0
        version: 1.0.0
packages:
  fixture@1.0.0:
    resolution: {integrity: sha512-${createHash('sha512').update(archive).digest('base64')}}
snapshots:
  fixture@1.0.0: {}
`
  const workspaceText = 'packages: []\nallowBuilds: {}\nignoreScripts: true\n'
  const metadata = translatePnpmLock({ lockfileText, workspaceText })
  const sidecar = await generatePnpmSha256Sidecar({ metadata, fetchArchive: async () => archive })
  const files = {
    'megarepo.json': '{}\n',
    'pnpm-lock.yaml': lockfileText,
    'pnpm-workspace.yaml': workspaceText,
    'package.json': '{"name":"freshness-fixture","private":true}\n',
    'buck2/dependencies/pnpm-lock.sha256.json': `${JSON.stringify(sidecar, null, 2)}\n`,
    'buck2/dependencies/BUCK': '',
  }
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  process.env.EFFECT_UTILS_PNPM_OFFLINE = '1'
  // Each case exercises loading the real generator from a separate declared tree.
  const generator = await import(pathToFileURL(join(root, 'buck2/dependencies/BUCK.genie.ts')).href)
  await writeFile(join(root, 'buck2/dependencies/BUCK'), generator.default.stringify({ cwd: root, location: 'buck2/dependencies', mode: 'check' }))
  const manifest: FreshnessManifest = {
    lockfile: 'pnpm-lock.yaml',
    workspaceManifests: ['pnpm-workspace.yaml', 'package.json'],
    patches: [],
    sidecar: 'buck2/dependencies/pnpm-lock.sha256.json',
    generatorSources: sources,
    committedOutputs: ['buck2/dependencies/BUCK', 'buck2/dependencies/pnpm-lock.sha256.json'],
    inputPaths: [...sources, ...Object.keys(files)],
    generator: 'buck2/dependencies/BUCK.genie.ts',
    repairCommand: 'devenv tasks run genie:run / devenv tasks run buck2:refresh-dependencies',
  }
  return { root, manifest, sidecar, output: join(root, 'result') }
}

describe('declared input freshness real-generator fixtures', () => {
  it('passes fresh BUCK and sidecar, emitting digests and an equality verdict', async () => {
    const data = await fixture()
    await Effect.runPromise(checkFreshness({ source: data.root, ...data }))
    expect(await readFile(join(data.output, 'freshness.ok'), 'utf8')).toBe('fresh\n')
    const report = JSON.parse(await readFile(join(data.output, 'freshness.json'), 'utf8'))
    expect(report.schema).toBe('effect-utils/declared-inputs-freshness/v1')
    expect(report.files.every((file: { verdict: string }) => file.verdict === 'fresh')).toBe(true)
    expect(report.inputs.length).toBeGreaterThan(10)
  })

  it('rejects stale BUCK with unified diff and repair command', async () => {
    const data = await fixture()
    await writeFile(join(data.root, 'buck2/dependencies/BUCK'), '# stale BUCK\n')
    await expect(Effect.runPromise(checkFreshness({ source: data.root, ...data }))).rejects.toThrow(/--- committed\/buck2\/dependencies\/BUCK[\s\S]*Repair: devenv tasks run genie:run/)
    const report = await readFile(join(data.output, 'freshness.json'), 'utf8')
    expect(report).toContain('# stale BUCK')
    expect(report).toContain('stale')
  })

  it('rejects stale sidecar fingerprint without refreshing', async () => {
    const data = await fixture()
    await writeFile(join(data.root, data.manifest.sidecar), JSON.stringify({ ...data.sidecar, lockfileFingerprint: `sha256:${'0'.repeat(64)}` }))
    await expect(Effect.runPromise(checkFreshness({ source: data.root, ...data }))).rejects.toThrow('stale sha256 sidecar lock fingerprint')
  })

  it('rejects a missing sidecar entry without fetching', async () => {
    const data = await fixture()
    await writeFile(join(data.root, data.manifest.sidecar), JSON.stringify({ ...data.sidecar, packages: {} }))
    await expect(Effect.runPromise(checkFreshness({ source: data.root, ...data }))).rejects.toThrow('stale sha256 sidecar package identity set')
  })
})
