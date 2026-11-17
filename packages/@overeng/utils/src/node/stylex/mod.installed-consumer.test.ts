import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const nodeExecutable = process.env.NODE_BIN ?? 'node'

/**
 * Vite loads config files through Node, which refuses TypeScript stripping for
 * packages under `node_modules`. A workspace-linked consumer never crosses that
 * boundary, so the failure only shows up in an installed topology — which is
 * why this entry is checked JavaScript rather than TypeScript. See #1167.
 */
it('loads the StyleX Vite entry from a node_modules-installed consumer', () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'overeng-stylex-vite-consumer-'))
  const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const installedPackage = join(consumerRoot, 'node_modules', '@overeng', 'utils')
  const configPath = join(consumerRoot, 'vite.config.mjs')
  const loaderPath = join(consumerRoot, 'load-config.mjs')

  try {
    mkdirSync(installedPackage, { recursive: true })
    cpSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'))
    cpSync(
      join(packageRoot, 'src', 'node', 'stylex'),
      join(installedPackage, 'src', 'node', 'stylex'),
      {
        recursive: true,
      },
    )
    for (const dependency of ['@stylexjs/unplugin', 'unplugin']) {
      const target = join(consumerRoot, 'node_modules', dependency)
      mkdirSync(join(target, '..'), { recursive: true })
      symlinkSync(join(packageRoot, 'node_modules', dependency), target, 'dir')
    }
    writeFileSync(
      configPath,
      [
        "import { createStylexVitePlugins } from '@overeng/utils/node/stylex'",
        '',
        'export default { plugins: [createStylexVitePlugins({ entries: [] })] }',
        '',
      ].join('\n'),
    )
    writeFileSync(
      loaderPath,
      [
        `import { loadConfigFromFile } from ${JSON.stringify(import.meta.resolve('vite'))}`,
        '',
        `const loaded = await loadConfigFromFile(`,
        `  { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false },`,
        `  ${JSON.stringify(configPath)},`,
        `  ${JSON.stringify(consumerRoot)},`,
        `  'silent',`,
        `  false,`,
        `  'bundle',`,
        `)`,
        `if (loaded === null || loaded.config.plugins?.[0]?.length !== 4) {`,
        `  throw new Error('Vite config did not load the StyleX plugins')`,
        `}`,
        '',
      ].join('\n'),
    )

    const result = spawnSync(nodeExecutable, [loaderPath], {
      cwd: consumerRoot,
      encoding: 'utf8',
    })

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' })
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
})

// A resolved server.close() promise is insufficient: the upstream poller kept
// Node alive afterwards. The child must exit naturally, without process.exit.
it.each(['shared factory', 'upstream ESM', 'upstream CJS'])(
  'naturally exits after closing middleware-mode Vite with %s',
  (entry) => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'overeng-stylex-shutdown-'))
    const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const require = createRequire(import.meta.url)
    const compilerImport =
      entry === 'shared factory'
        ? `import { createStylexVitePlugins } from ${JSON.stringify(new URL('./mod.js', import.meta.url).href)}
           const plugins = createStylexVitePlugins()`
        : entry === 'upstream ESM'
          ? `import stylex from ${JSON.stringify(import.meta.resolve('@stylexjs/unplugin/vite'))}
             const plugins = [stylex()]`
          : `import { createRequire } from 'node:module'
             const require = createRequire(${JSON.stringify(import.meta.url)})
             const plugins = [require(${JSON.stringify(require.resolve('@stylexjs/unplugin/vite'))}).default()]`

    try {
      const result = spawnSync(
        nodeExecutable,
        [
          '--input-type=module',
          '-e',
          `
            import assert from 'node:assert/strict'
            import { createServer } from ${JSON.stringify(import.meta.resolve('vite'))}
            ${compilerImport}
            // Reuse the plugin through two real server lifecycles.
            for (let run = 0; run < 2; run++) {
              const server = await createServer({
                configFile: false,
                root: ${JSON.stringify(packageRoot)},
                cacheDir: ${JSON.stringify(cacheDir)},
                logLevel: 'silent',
                plugins,
                optimizeDeps: { noDiscovery: true },
                server: { middlewareMode: true, watch: null },
              })
              assert.equal(server.httpServer, null)
              await server.close()
              console.log('closed')
            }
          `,
        ],
        { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 },
      )

      expect({
        error: result.error?.message,
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual({
        error: undefined,
        status: 0,
        signal: null,
        stdout: 'closed\nclosed\n',
        stderr: '',
      })
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  },
)
