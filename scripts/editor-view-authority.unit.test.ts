import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import testScheduling from '../genie/ci-workflow/test-scheduling.json'
import {
  changedEditorConsumers,
  decodePublicationPackagePaths,
  editorViewPackagePaths,
  editorViewPlan,
  resolveEditorViewPackageScope,
} from './editor-view-authority.ts'
import { workspaceEditorDependencies } from './editor-view-authority.ts'

describe('editor view authority orchestration', () => {
  it('fails closed to all consumers for changes, including reverse dependencies and global inputs', () => {
    expect(
      changedEditorConsumers({
        changed: ['packages/a/src/one.ts'],
        packagePaths: ['.', 'packages/a', 'packages/ab'],
      }),
    ).toEqual(['.', 'packages/a', 'packages/ab'])
    expect(changedEditorConsumers({ changed: [], packagePaths: ['.'] })).toEqual([])
  })

  it('selects the importer reverse closure, not just the changed owner', () => {
    const dependencies = workspaceEditorDependencies({
      serialized: `importers:
  .: {}
  packages/a: {}
  packages/consumer:
    dependencies:
      a: {specifier: 'workspace:*', version: 'link:../a'}
  packages/transitive:
    devDependencies:
      consumer: {specifier: 'workspace:*', version: 'link:../consumer'}
  packages/unrelated: {}
`,
      rootBuck: `alias(name = "editor_inputs", actual = ":node_modules")
alias(name = "node_modules", actual = "//packages/consumer:node_modules")
alias(name = "root_editor_package_tree", actual = "//packages/consumer:package_tree")`,
    })
    expect(
      changedEditorConsumers({
        changed: ['packages/a/src/one.ts'],
        packagePaths: Object.keys(dependencies),
        readDependencies: () => dependencies,
      }),
    ).toEqual(['.', 'packages/a', 'packages/consumer', 'packages/transitive'])
  })

  it('falls back to all consumers for global inputs and unproven ownership', () => {
    const packagePaths = ['.', 'packages/a', 'packages/consumer']
    expect(
      changedEditorConsumers({
        changed: ['packages/a/BUCK'],
        packagePaths,
        readDependencies: () => {
          throw new Error('must not query global invalidators')
        },
      }),
    ).toEqual(packagePaths)
    expect(
      changedEditorConsumers({
        changed: ['packages/a/src/removed.ts'],
        packagePaths,
        readDependencies: () => ({}),
      }),
    ).toEqual(packagePaths)
  })

  it('derives one deterministic editor publication entry per workspace consumer', () => {
    const plan = editorViewPlan({ cell: 'workspace_cell' })

    expect(plan.packages.map(({ packagePath }) => packagePath)).toEqual(editorViewPackagePaths)
    expect(plan.packages).toHaveLength(editorViewPackagePaths.length)
    expect(plan.packages[0]?.editor).toMatchObject({
      cell: 'workspace_cell',
      inputsManifestTarget: 'workspace_cell//:editor_view_inputs',
      target: '//:editor_inputs',
      viewName: 'root',
    })
    for (const entry of plan.packages.slice(1)) {
      expect(entry.editor?.cell).toBe('workspace_cell')
      expect(entry.editor?.inputsManifestTarget).toBe(
        `workspace_cell//${entry.packagePath}:editor_view_inputs`,
      )
      expect(entry.editor?.target).toBe(`//${entry.packagePath}:editor_inputs`)
    }
  })

  it('starts long declared editor views first without changing their authority or targets', () => {
    const packagePaths = [
      '.',
      ...Object.keys(testScheduling.editorViewSeconds).filter((path) => path !== '.'),
    ]
    const lexical = editorViewPlan({ cell: 'workspace_cell', packagePaths })
    const weighted = editorViewPlan({
      cell: 'workspace_cell',
      packagePaths,
      packageWeights: testScheduling.editorViewSeconds,
    })
    const weights: Readonly<Record<string, number>> = testScheduling.editorViewSeconds

    expect(weighted.packages.map(({ packagePath }) => packagePath)).toEqual(
      [...packagePaths].sort((left, right) => {
        const difference = (weights[right] ?? 1) - (weights[left] ?? 1)
        return difference !== 0 ? difference : left === right ? 0 : left < right ? -1 : 1
      }),
    )
    expect(weighted.packages.slice(0, 2).map(({ packagePath }) => packagePath)).toEqual([
      'packages/@overeng/notion-cli',
      'packages/@overeng/notion-datasource-sync',
    ])
    expect(
      weighted.packages.toSorted((left, right) =>
        left.packagePath.localeCompare(right.packagePath),
      ),
    ).toEqual(
      lexical.packages.toSorted((left, right) => left.packagePath.localeCompare(right.packagePath)),
    )
  })

  it('uses lexical ties and weight one for editor views without a declared duration', () => {
    const plan = editorViewPlan({
      cell: 'workspace_cell',
      packagePaths: ['packages/@overeng/utils', '.', 'packages/@overeng/genie'],
      packageWeights: { 'packages/@overeng/genie': 10 },
    })
    expect(plan.packages.map(({ packagePath }) => packagePath)).toEqual([
      'packages/@overeng/genie',
      '.',
      'packages/@overeng/utils',
    ])
  })

  it('declares a single positive worker count and positive integer duration weights', () => {
    expect(Number.isInteger(testScheduling.workers)).toBe(true)
    expect(testScheduling.workers).toBeGreaterThan(0)
    for (const weights of [
      testScheduling.sourceTaskSeconds,
      testScheduling.moduleScriptSeconds,
      testScheduling.editorViewSeconds,
    ]) {
      for (const weight of Object.values(weights)) {
        expect(Number.isInteger(weight)).toBe(true)
        expect(weight).toBeGreaterThan(0)
      }
    }
  })

  it('canonicalizes an explicit publication scope against the admitted registry', () => {
    const serializedPublicationPackages = JSON.stringify([
      'packages/@overeng/utils',
      'packages/@overeng/tui-react',
    ])

    expect(decodePublicationPackagePaths(serializedPublicationPackages)).toEqual([
      'packages/@overeng/tui-react',
      'packages/@overeng/utils',
    ])
  })

  it.each([
    ['not JSON', '{', '--packages must be a JSON array'],
    ['an empty array', '[]', '--packages must be a non-empty JSON array of package paths'],
    [
      'a non-string entry',
      '["packages/@overeng/utils",1]',
      '--packages must be a non-empty JSON array of package paths',
    ],
    [
      'a duplicate package',
      '["packages/@overeng/utils","packages/@overeng/utils"]',
      '--packages repeats a package path',
    ],
    [
      'an unregistered package',
      '["packages/@overeng/not-admitted"]',
      '--packages contains an unregistered editor consumer',
    ],
  ])('rejects %s', (_case, serialized, message) => {
    expect(() => decodePublicationPackagePaths(serialized)).toThrow(message)
  })

  it('keeps whole-workspace authority while narrowing only the publication plan', () => {
    const scope = resolveEditorViewPackageScope({
      command: 'publish',
      authorityPackagePaths: editorViewPackagePaths,
      serializedPublicationPackages: JSON.stringify(['packages/@overeng/utils']),
    })

    expect(scope.authorityPackagePaths).toBe(editorViewPackagePaths)
    expect(scope.publicationPackagePaths).toEqual(['packages/@overeng/utils'])
    expect(
      editorViewPlan({
        cell: 'workspace_cell',
        packagePaths: scope.publicationPackagePaths,
      }).packages.map(({ packagePath }) => packagePath),
    ).toEqual(['packages/@overeng/utils'])
  })

  it('bootstraps the declared generator import closure under whole-workspace authority', () => {
    const bootstrapPackagePaths = ['.', 'packages/@overeng/otel-contract']
    const scope = resolveEditorViewPackageScope({
      command: 'bootstrap',
      authorityPackagePaths: editorViewPackagePaths,
      serializedPublicationPackages: JSON.stringify(bootstrapPackagePaths),
    })

    expect(scope.authorityPackagePaths).toBe(editorViewPackagePaths)
    expect(scope.publicationPackagePaths).toEqual(bootstrapPackagePaths)
    expect(
      editorViewPlan({
        cell: 'workspace_cell',
        packagePaths: scope.publicationPackagePaths,
      }).packages.map(({ packagePath }) => packagePath),
    ).toEqual(bootstrapPackagePaths)
  })

  it('retains whole-workspace publication when no explicit scope is provided', () => {
    const scope = resolveEditorViewPackageScope({
      command: 'publish',
      authorityPackagePaths: editorViewPackagePaths,
      serializedPublicationPackages: undefined,
    })

    expect(scope.authorityPackagePaths).toBe(editorViewPackagePaths)
    expect(scope.publicationPackagePaths).toBe(editorViewPackagePaths)
  })

  it('requires an explicit bootstrap scope and rejects explicit scopes on read-only commands', () => {
    expect(() =>
      resolveEditorViewPackageScope({
        command: 'bootstrap',
        authorityPackagePaths: editorViewPackagePaths,
        serializedPublicationPackages: undefined,
      }),
    ).toThrow('--packages is required with bootstrap')
    for (const command of ['authority', 'check'] as const)
      expect(() =>
        resolveEditorViewPackageScope({
          command,
          authorityPackagePaths: editorViewPackagePaths,
          serializedPublicationPackages: '["packages/@overeng/utils"]',
        }),
      ).toThrow('--packages is only valid with publish or bootstrap')
  })

  it('rejects an invalid explicit scope before attempting authority or Buck work', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'editor-view-authority.ts')
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        script,
        'publish',
        '--repo-root',
        '/does-not-exist',
        '--workspace-root',
        '/does-not-exist',
        '--cell',
        'workspace_cell',
        '--buck2',
        '/does-not-exist/buck2',
        '--buck2-native',
        '/does-not-exist/buck2-native',
        '--git',
        '/does-not-exist/git',
        '--output',
        '/does-not-exist/authority.json',
        '--publisher',
        '/does-not-exist/publisher.ts',
        '--cp',
        '/does-not-exist/cp',
        '--mv',
        '/does-not-exist/mv',
        '--fingerprint-tool',
        '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-x/bin/buck2-fingerprint',
        '--snapshot-retention',
        '3',
        '--packages',
        '["packages/@overeng/not-admitted"]',
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      '--packages contains an unregistered editor consumer: packages/@overeng/not-admitted',
    )
  })

  it('rejects a missing bootstrap scope before attempting authority or Buck work', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'editor-view-authority.ts')
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        script,
        'bootstrap',
        '--repo-root',
        '/does-not-exist',
        '--workspace-root',
        '/does-not-exist',
        '--cell',
        'workspace_cell',
        '--buck2',
        '/does-not-exist/buck2',
        '--buck2-native',
        '/does-not-exist/buck2-native',
        '--git',
        '/does-not-exist/git',
        '--output',
        '/does-not-exist/authority.json',
        '--publisher',
        '/does-not-exist/publisher.ts',
        '--cp',
        '/does-not-exist/cp',
        '--mv',
        '/does-not-exist/mv',
        '--fingerprint-tool',
        '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-x/bin/buck2-fingerprint',
        '--snapshot-retention',
        '3',
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toBe(
      'editor view authority: --packages is required with bootstrap\n',
    )
  })
})

for (const [signal, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const)
  it(`preserves ${signal}'s cancellation status after the authority joins native cleanup`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'authority-cancellation-')))
    const script = join(dirname(fileURLToPath(import.meta.url)), 'editor-view-authority.ts')
    const ready = Promise.withResolvers<void>()
    const marker = join(root, 'native-ready')
    const watcher = watch(root, () => {
      if (existsSync(marker)) ready.resolve()
    })
    const native = join(root, 'native')
    const git = join(root, 'git')
    const tracked = editorViewPackagePaths.map((path) =>
      path === '.' ? 'package.json' : `${path}/package.json`,
    ).join('\0') + '\0'
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(join(root, '.buckconfig'), '')
    writeFileSync(git,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(tracked)})\n`,
      { mode: 0o755 },
    )
    writeFileSync(native, `#!${process.execPath}
      import { createServer } from 'node:net';
      import { writeFileSync } from 'node:fs';
      const live = createServer();
      process.once('SIGTERM', () => {
        live.close();
        process.kill(process.pid, 'SIGTERM');
      });
      live.listen(0, '127.0.0.1', () =>
        writeFileSync(${JSON.stringify(marker)}, 'ready'));
    `, { mode: 0o755 })
    const child = spawn(process.execPath, [
      script, 'bootstrap',
      '--repo-root', root, '--workspace-root', root, '--cell', 'effect_utils',
      '--buck2', native, '--buck2-native', native, '--git', git,
      '--output', join(root, 'authority.json'),
      '--publisher', '/unused/publisher.ts', '--cp', '/unused/cp', '--mv', '/unused/mv',
      '--fingerprint-tool', '/unused/buck2-fingerprint', '--snapshot-retention', '3',
      '--packages', '["."]',
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: join(root, 'home'),
        PATH: process.env.PATH,
        BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY: process.env.BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY,
      },
    })
    let diagnostics = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostics += chunk })
    const completion = Promise.withResolvers<{
      code: number | null
      signal: NodeJS.Signals | null
    }>()
    const closed = completion.promise
    child.once('error', completion.reject)
    child.once('close', (code, childSignal) => completion.resolve({ code, signal: childSignal }))
    try {
      await Promise.race([
        ready.promise,
        closed.then(() => { throw new Error(`authority exited before native readiness: ${diagnostics}`) }),
      ])
      child.kill(signal)
      expect(await closed).toEqual({ code: status, signal: null })
    } finally {
      child.kill('SIGKILL')
      await closed
      watcher.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 10000)
