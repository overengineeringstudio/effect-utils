import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

import { createBuildIdentityPlugin } from './vite-build-identity.js'

it('loads installed Node config, preserving immutable Nix metadata and runtime closure identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'build-identity-installed-'))
  const installed = join(root, 'node_modules/@overeng/utils')
  const source = fileURLToPath(new URL('.', import.meta.url))
  const stamp = { type: 'nix', version: '1.2.3', rev: 'abcdef1', commitTs: 1700000000, dirty: false }
  try {
    mkdirSync(join(installed, 'src/node'), { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({
      type: 'module', exports: { './node/vite-build-identity': './src/node/vite-build-identity.js' },
    }))
    for (const name of ['cli-build-identity.js', 'vite-build-identity.js']) {
      copyFileSync(join(source, name), join(installed, 'src/node', name))
    }
    writeFileSync(join(root, 'entry.js'), "import {buildIdentity,deploymentId} from 'virtual:build-identity'; globalThis.provenance={buildIdentity,deploymentId};")
    writeFileSync(join(root, 'vite.config.mjs'), `import {createBuildIdentityPlugin} from '@overeng/utils/node/vite-build-identity'; export default {plugins:[createBuildIdentityPlugin({baseVersion:'9.9.9',buildStamp:${JSON.stringify(JSON.stringify(stamp))}})],build:{minify:false,rollupOptions:{input:'entry.js'}}};`)
    writeFileSync(join(root, 'run.mjs'), `import {build} from ${JSON.stringify(import.meta.resolve('vite'))}; import {readFileSync,readdirSync} from 'node:fs'; import {runInNewContext} from 'node:vm'; await build({root:${JSON.stringify(root)},logLevel:'silent'}); const sandbox={__BUILD_DEPLOYMENT_ID__:'/nix/store/actual-package'}; runInNewContext(readFileSync('dist/assets/'+readdirSync('dist/assets').find(n=>n.endsWith('.js')),'utf8'),sandbox); console.log(JSON.stringify(sandbox.provenance));`)
    const result = spawnSync(process.env['NODE_BIN'] ?? process.execPath, [join(root, 'run.mjs')], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CLI_BUILD_STAMP: JSON.stringify({ type: 'local', rev: 'wrong', ts: 1800000000, dirty: true }) },
    })
    expect(result.status, result.stderr).toBe(0)
    const provenance = JSON.parse(result.stdout)
    expect(provenance).toEqual({
      buildIdentity: expect.objectContaining({
        baseVersion: '1.2.3', machineVersion: '1.2.3+abcdef1',
        sourceKind: 'nix', rev: 'abcdef1', commitTs: 1700000000, dirty: false,
      }),
      deploymentId: '/nix/store/actual-package',
    })
    expect(JSON.parse(readFileSync(join(root, 'dist/build-identity.json'), 'utf8'))).toMatchObject({
      machineVersion: '1.2.3+abcdef1', sourceKind: 'nix', rev: 'abcdef1', commitTs: 1700000000, dirty: false,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads the served worktree revision and dirty state instead of a stale shell identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'build-identity-worktree-'))
  let server: ViteDevServer | undefined
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '--quiet')
    writeFileSync(join(root, 'entry.js'), 'export const value = 1\n')
    git('add', 'entry.js')
    // This isolated fixture must not inherit a workstation's repository-specific commit hooks.
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Build identity fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
    const rev = git('rev-parse', '--short', 'HEAD')
    writeFileSync(join(root, 'entry.js'), 'export const value = 2\n')
    server = await createServer({
      configFile: false, root, logLevel: 'silent', optimizeDeps: { noDiscovery: true },
      plugins: [createBuildIdentityPlugin({ baseVersion: '1.2.3', buildStamp: '__CLI_BUILD_STAMP__' })],
      server: { middlewareMode: true },
    })
    const result = await server.ssrLoadModule('virtual:build-identity')
    expect(result.buildIdentity.machineVersion).toBe(`1.2.3+local.${rev}.dirty`)
    expect(result.buildIdentity.sourceKind).toBe('local')
    expect(result.buildIdentity.dirty).toBe(true)
    expect(result.buildIdentity.buildTs).toBeGreaterThan(0)
    expect(result.deploymentId).toBe('dev (HMR)')
  } finally {
    await server?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
