import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { runPackageTreeCli } from './package-tree.ts'

const bun = realpathSync(process.execPath)
const runner = fileURLToPath(new URL('./package-command-runner.ts', import.meta.url))
const fingerprintTool = ((): string => {
  const tool = process.env['FINGERPRINT_BIN']
  if (tool === undefined || tool === '')
    throw new Error('declared test tool is unavailable: FINGERPRINT_BIN')
  return tool
})()

describe('package command input immutability', () => {
  it.each([
    { name: 'package tree', readRoot: false },
    { name: 'declared read root', readRoot: true },
  ])('rejects a successful command that mutates its $name', async ({ readRoot }) => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'package-command-input-mutation-'))
    const packageTree = join(root, 'package-tree')
    const dependency = join(root, 'dependency')
    const verdict = join(root, 'verdict')
    const stderrPath = join(root, 'stderr')
    try {
      await Promise.all([mkdir(packageTree), mkdir(dependency)])
      await writeFile(
        join(packageTree, 'mutate.ts'),
        `import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2]!, 'mutated')
`,
      )
      const mutationTarget = join(readRoot === true ? dependency : packageTree, 'mutation')
      const command = [
        bun,
        runner,
        'check',
        bun,
        packageTree,
        'mutate.ts',
        verdict,
        '--fingerprint-tool',
        fingerprintTool,
        '--arg',
        mutationTarget,
        ...(readRoot === true ? ['--read-root', dependency] : []),
      ]
      const child = Bun.spawn(command, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: Bun.file(stderrPath),
      })
      const exitCode = await child.exited
      const stderr = await readFile(stderrPath, 'utf8')

      expect(exitCode).toBe(1)
      expect(stderr).toContain('declared inputs changed while mutate.ts was running')
      expect(existsSync(verdict)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('bundle fingerprint capability isolation', () => {
  it('builds without any fingerprint tool and rejects an undeclared capability', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'package-command-bundle-'))
    const packageTree = join(root, 'package-tree')
    const output = join(root, 'module.js')
    const descriptor = join(root, 'module.json')
    const stderrPath = join(root, 'stderr')
    try {
      await mkdir(packageTree)
      await writeFile(join(packageTree, 'mod.ts'), 'export const value = 42\n')
      const command = [
        bun,
        runner,
        'bundle',
        bun,
        packageTree,
        'mod.ts',
        output,
        '--descriptor',
        descriptor,
        '--target-identity',
        'cell//fixture:module',
      ]
      // No tool is discoverable through PATH or the integration harness's
      // declared tool environment. A guard or ambient fallback would fail.
      const env = { ...process.env, PATH: '', FINGERPRINT_BIN: '', BUCK_SCRATCH_PATH: root }
      const child = Bun.spawn(command, {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: Bun.file(stderrPath),
      })
      expect(await child.exited).toBe(0)
      expect(await readFile(stderrPath, 'utf8')).toBe('')
      expect(await readFile(output, 'utf8')).toContain('42')
      expect(JSON.parse(await readFile(descriptor, 'utf8'))).toMatchObject({
        schema: 'effect-utils/javascript-module/v2',
        target: 'cell//fixture:module',
      })

      await rm(output)
      await rm(descriptor)
      // Negative control: even a syntactically immutable path cannot grant a
      // bundle the fingerprint capability it does not declare.
      const rejected = Bun.spawn(
        [
          ...command,
          '--fingerprint-tool',
          '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-undeclared/bin/buck2-fingerprint',
        ],
        {
          env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: Bun.file(stderrPath),
        },
      )
      expect(await rejected.exited).toBe(1)
      expect(await readFile(stderrPath, 'utf8')).toContain(
        'bundle does not accept --fingerprint-tool',
      )
      expect(existsSync(output)).toBe(false)
      expect(existsSync(descriptor)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const bundleWorkspaceSources = async ({
  root,
  missingExport = false,
}: {
  readonly root: string
  readonly missingExport?: boolean
}): Promise<{
  readonly bytes: string | undefined
  readonly exitCode: number
  readonly stderr: string
}> => {
  const sources = join(root, 'authored')
  const leaf = join(root, 'leaf-product-tree')
  const workspace = join(root, 'workspace-product-tree')
  const packageTree = join(root, 'product-package-tree')
  const leafView = join(root, 'leaf-product-view')
  const workspaceView = join(root, 'workspace-product-view')
  const view = join(root, 'product-view')
  const external = join(root, 'external-entry')
  const output = join(root, 'module.js')
  const descriptor = join(root, 'module.json')
  const stderrPath = join(root, 'stderr')
  const source = async (file: string, contents: string): Promise<string> => {
    const target = join(sources, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
    return target
  }
  const leafManifest = await source(
    'leaf/package.json',
    JSON.stringify({
      name: '@scope/leaf',
      type: 'module',
      exports: { '.': { types: './dist/lib/value.d.ts', default: './lib/value.ts' } },
    }),
  )
  const leafSource = await source(
    'leaf/lib/value.ts',
    "import { external } from 'external-data'\nexport const value = `source:${external}`\n",
  )
  const workspaceManifest = await source(
    'workspace/package.json',
    JSON.stringify({
      name: '@scope/workspace',
      type: 'module',
      exports: { '.': { types: './dist/runtime/api.d.ts', default: './runtime/api.ts' } },
      publishConfig: { exports: { '.': './dist/runtime/api.js' } },
    }),
  )
  const workspaceSource = await source(
    'workspace/runtime/api.ts',
    "import { value as leafValue } from '@scope/leaf'\nexport const value = `workspace:${leafValue}`\n",
  )
  const helperSource = await source('workspace/runtime/helper.ts', 'export const helper = true\n')
  const packageManifest = await source(
    'consumer/package.json',
    '{"name":"consumer","type":"module"}\n',
  )
  const project = await source(
    'consumer/tsconfig.json',
    '{"compilerOptions":{"target":"ES2024"},"references":[{"path":"../workspace"}]}\n',
  )
  const entry = await source(
    'consumer/src/mod.ts',
    "import { value } from '@scope/workspace'\nexport const result = value\n",
  )
  await mkdir(join(external, 'node_modules', 'external-data'), { recursive: true })
  await writeFile(
    join(external, 'node_modules', 'external-data', 'package.json'),
    '{"name":"external-data","type":"module","exports":"./index.js"}\n',
  )
  await writeFile(
    join(external, 'node_modules', 'external-data', 'index.js'),
    "export const external = 'external'\n",
  )
  await mkdir(leafView)
  await symlink(
    relative(leafView, join(external, 'node_modules', 'external-data')),
    join(leafView, 'external-data'),
  )
  runPackageTreeCli([
    '--output',
    leaf,
    '--dependency-view',
    leafView,
    '--file',
    'package.json',
    leafManifest,
    '--file',
    'lib/value.ts',
    leafSource,
  ])
  await mkdir(join(workspaceView, '@scope'), { recursive: true })
  await symlink(
    relative(join(workspaceView, '@scope'), leaf),
    join(workspaceView, '@scope', 'leaf'),
  )
  runPackageTreeCli([
    '--output',
    workspace,
    '--dependency-view',
    workspaceView,
    '--file',
    'package.json',
    workspaceManifest,
    '--file',
    'runtime/helper.ts',
    helperSource,
    ...(missingExport === true ? [] : ['--file', 'runtime/api.ts', workspaceSource]),
    '--workspace-file',
    'node_modules/@scope/leaf/package.json',
    leafManifest,
    '--workspace-dependency-view',
    'node_modules/@scope/leaf/node_modules',
    leaf,
  ])
  await mkdir(join(view, '@scope'), { recursive: true })
  await symlink(relative(join(view, '@scope'), workspace), join(view, '@scope', 'workspace'))
  runPackageTreeCli([
    '--output',
    packageTree,
    '--dependency-view',
    view,
    '--file',
    'package.json',
    packageManifest,
    '--file',
    'tsconfig.json',
    project,
    '--file',
    'src/mod.ts',
    entry,
    '--strip-project-references',
    'true',
    '--workspace-file',
    'node_modules/@scope/workspace/package.json',
    workspaceManifest,
    '--workspace-dependency-view',
    'node_modules/@scope/workspace/node_modules',
    workspace,
  ])
  expect(existsSync(join(workspace, 'dist'))).toBe(false)
  expect(existsSync(join(leaf, 'dist'))).toBe(false)
  const closureRoots = [
    { name: 'cell/dependencies/view_consumer/node_modules', path: view },
    { name: 'cell/workspace/package_tree/package_tree', path: workspace },
    { name: 'cell/dependencies/view_workspace/node_modules', path: workspaceView },
    { name: 'cell/leaf/package_tree/package_tree', path: leaf },
    { name: 'cell/dependencies/view_leaf/node_modules', path: leafView },
    { name: 'cell/dependencies/entry_external/entry', path: external },
  ]
  const child = Bun.spawn(
    [
      bun,
      runner,
      'bundle',
      bun,
      packageTree,
      'src/mod.ts',
      output,
      '--kind',
      'module',
      '--descriptor',
      descriptor,
      '--target-identity',
      'cell//consumer:module',
      ...closureRoots.flatMap(({ name, path }) => ['--closure-root', `${name}\t${path}`]),
    ],
    {
      env: { ...process.env, PATH: '', FINGERPRINT_BIN: '', BUCK_SCRATCH_PATH: root },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: Bun.file(stderrPath),
    },
  )
  const exitCode = await child.exited
  return {
    bytes: existsSync(output) === true ? await readFile(output, 'utf8') : undefined,
    exitCode,
    stderr: await readFile(stderrPath, 'utf8'),
  }
}

describe('source-only workspace export bundling', () => {
  it('resolves recursive runtime source exports through the portable farm without any dist or fingerprint tool', async () => {
    const first = await mkdtemp(join(realpathSync(tmpdir()), 'workspace-source-first-'))
    const second = await mkdtemp(join(realpathSync(tmpdir()), 'workspace-source-second-'))
    try {
      const left = await bundleWorkspaceSources({ root: first })
      const right = await bundleWorkspaceSources({ root: second })
      expect(left.exitCode, left.stderr).toBe(0)
      expect(right.exitCode, right.stderr).toBe(0)
      expect(left.bytes).toContain('workspace:')
      expect(left.bytes).toContain('source:')
      expect(left.bytes).toContain(
        '.closure/cell/workspace/package_tree/package_tree/runtime/api.ts',
      )
      expect(left.bytes).toContain('.closure/cell/leaf/package_tree/package_tree/lib/value.ts')
      expect(right.bytes).toBe(left.bytes)
      // Live code at both workspace boundaries proves recursive source
      // resolution; a bare re-export can disappear from Bun's module comments.
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(left.bytes ?? '').toString('base64')}`
      // oxlint-disable-next-line import/no-dynamic-require -- the data URL executes this test's runtime-generated bundle
      expect((await import(moduleUrl)).result).toBe('workspace:source:external')
      expect(left.bytes).not.toContain(first)
      expect(right.bytes).not.toContain(second)
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ])
    }
  })

  it('fails when the actual exported source is missing rather than falling back to declaration or published paths', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'workspace-source-missing-'))
    try {
      const result = await bundleWorkspaceSources({ root, missingExport: true })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/@scope\/workspace|runtime\/api\.ts/u)
      expect(result.bytes).toBeUndefined()
      expect(existsSync(join(root, 'module.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
