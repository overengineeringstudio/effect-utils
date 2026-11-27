import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
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

it('joins the real cancellation callback before preserving SIGTERM status', async () => {
  // Keep signal handlers and exit status in the child, not Bun's test runner.
  const module = new URL('./editor-view-authority.ts', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import { withPublicationCancellation } from ${JSON.stringify(module)};
    const ready = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const cleanup = Promise.withResolvers();
    let settled = false;
    const outcome = withPublicationCancellation({
      run: async signal => {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        ready.resolve();
        await cleanup.promise;
      },
    }).then(
      () => { settled = true; },
      error => { settled = true; return error; },
    );
    try {
      await ready.promise;
      process.kill(process.pid, 'SIGTERM');
      await aborted.promise;
      assert.equal(settled, false);
      assert.equal(process.exitCode, 143);
      cleanup.resolve();
      assert(await outcome instanceof Error);
      process.stdout.write('cleanup-joined\\n');
    } finally {
      cleanup.resolve();
      await outcome;
    }
  `
  const child = spawn(process.execPath, ['--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: 5000,
    killSignal: 'SIGKILL',
  })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let output = ''
  let diagnostics = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics += chunk
  })
  try {
    expect(await closed, diagnostics).toBe(143)
    expect(output).toBe('cleanup-joined\n')
  } finally {
    child.kill('SIGKILL')
    await closed
  }
}, 10000)

it('consumes a real child notification descriptor exactly once before descendants', async () => {
  const module = new URL('./editor-view-authority.ts', import.meta.url).href
  for (const [notification, expected] of [
    ['owner-acquired', '1'],
    ['no-publication', '0'],
  ] as const) {
    const source = `
      import { takePublicationAdmissionNotification } from ${JSON.stringify(module)};
      const notify = takePublicationAdmissionNotification();
      if ('EDITOR_VIEW_ADMISSION_READY_FD' in process.env) throw new Error('notification escaped');
      notify(${JSON.stringify(notification)});
      notify('no-publication');
    `
    const child = spawn(process.execPath, ['--eval', source], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, EDITOR_VIEW_ADMISSION_READY_FD: '3' },
      timeout: 5000,
      killSignal: 'SIGKILL',
    })
    const completion = Promise.withResolvers<{
      code: number | null
      signal: NodeJS.Signals | null
    }>()
    child.once('error', completion.reject)
    child.once('close', (code, signal) => completion.resolve({ code, signal }))
    const pipe = child.stdio[3]
    let output = ''
    let diagnostics = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostics += chunk
    })
    try {
      if (!(pipe instanceof Readable)) throw new Error('missing real notification pipe')
      pipe.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk
      })
      expect(await completion.promise, diagnostics).toEqual({ code: 0, signal: null })
      expect(output).toBe(expected)
    } finally {
      child.kill('SIGKILL')
      await completion.promise
    }
  }
}, 15000)
