import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

it('loads the Vite entry point from a node_modules-installed consumer', () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'stylex-preset-vite-consumer-'))
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const installedPackage = join(consumerRoot, 'node_modules', '@overeng', 'stylex-preset')
  const configPath = join(consumerRoot, 'vite.config.mjs')
  const loaderPath = join(consumerRoot, 'load-config.mjs')

  try {
    mkdirSync(installedPackage, { recursive: true })
    cpSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'))
    cpSync(join(packageRoot, 'src'), join(installedPackage, 'src'), { recursive: true })
    mkdirSync(join(consumerRoot, 'node_modules', '@stylexjs'), { recursive: true })
    symlinkSync(
      join(packageRoot, 'node_modules', '@stylexjs', 'unplugin'),
      join(consumerRoot, 'node_modules', '@stylexjs', 'unplugin'),
      'dir',
    )
    symlinkSync(
      join(packageRoot, 'node_modules', 'unplugin'),
      join(consumerRoot, 'node_modules', 'unplugin'),
      'dir',
    )
    writeFileSync(
      configPath,
      [
        "import { createStylexVitePlugin } from '@overeng/stylex-preset/vite'",
        '',
        'export default { plugins: [createStylexVitePlugin()] }',
        '',
      ].join('\n'),
    )
    writeFileSync(
      loaderPath,
      [
        `import { loadConfigFromFile } from ${JSON.stringify(import.meta.resolve('vite'))}`,
        '',
        `const loaded = await loadConfigFromFile(`,
        `  { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false },`,
        `  ${JSON.stringify(configPath)},`,
        `  ${JSON.stringify(consumerRoot)},`,
        `  'silent',`,
        `  false,`,
        `  'bundle',`,
        `)`,
        `if (loaded === null || loaded.config.plugins?.length !== 1) {`,
        `  throw new Error('Vite config did not load the StyleX plugin')`,
        `}`,
        '',
      ].join('\n'),
    )

    const result = spawnSync(process.execPath, [loaderPath], {
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
