import { describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const authorityModule = fileURLToPath(new URL('./editor-view-authority.ts', import.meta.url))
const ownerModule = fileURLToPath(new URL(
  '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts', import.meta.url))

describe('prepared native admission protocol', () => {
  it('writes exactly one terminal byte, removes descendant environment and closes the real pipe', () => {
    for (const [outcome, byte] of [
      ['owner-acquired', '1'], ['no-publication', '0'],
    ]) {
      const driver = `
import { fstatSync } from 'node:fs'
import { takePublicationAdmissionNotification } from ${JSON.stringify(authorityModule)}
const notify = takePublicationAdmissionNotification()
if ('EDITOR_VIEW_ADMISSION_READY_FD' in process.env) throw new Error('descriptor environment leaked')
notify(${JSON.stringify(outcome)})
notify('owner-acquired')
try { fstatSync(3); throw new Error('notification descriptor leaked') }
catch (error) { if (error.code !== 'EBADF') throw error }
process.stdout.write('closed')
`
      const result = spawnSync(process.execPath, ['-e', driver], {
        env: { ...process.env, EDITOR_VIEW_ADMISSION_READY_FD: '3' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe('closed')
      expect(result.output[3]).toBe(byte)
    }
  })

  it('rejects invalid or closed notification descriptors without treating them as ownership', () => {
    for (const descriptor of ['0', '1', '2', '-1', 'NaN', '3.5', '9007199254740992', '999999']) {
      const result = spawnSync(process.execPath, ['-e', `
import { takePublicationAdmissionNotification } from ${JSON.stringify(authorityModule)}
takePublicationAdmissionNotification()('owner-acquired')
`], { env: { ...process.env, EDITOR_VIEW_ADMISSION_READY_FD: descriptor }, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(descriptor === '999999' ? /EBADF/ : /Invalid.*descriptor/)
    }
    const env = { ...process.env }
    delete env.EDITOR_VIEW_ADMISSION_READY_FD
    const absent = spawnSync(process.execPath, ['-e', `
import { takePublicationAdmissionNotification } from ${JSON.stringify(authorityModule)}
const notify = takePublicationAdmissionNotification()
notify('no-publication')
notify('owner-acquired')
`], { env, encoding: 'utf8' })
    expect(absent.status).toBe(0)
  })

  it('cancels and joins native descendants before releasing the real owner and restores listeners', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'authority-cancellation-')))
    const native = join(root, 'native')
    const joined = join(root, 'joined')
    const childPid = join(root, 'child-pid')
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(join(root, '.buckconfig'), '')
    writeFileSync(native, `#!/bin/sh
trap 'kill -TERM "$kid"; wait "$kid"; printf joined > "$JOINED"; exit 0' TERM
/bin/sh -c 'printf ready >&2; while :; do :; done' &
kid=$!
printf '%s' "$kid" > "$CHILD_PID"
wait "$kid"
`, { mode: 0o755 })
    const driver = `
import { existsSync } from 'node:fs'
import { runManagedEditorPublicationCommand, withPublicationCancellation } from ${JSON.stringify(authorityModule)}
import { editorPublicationIsolation, withEditorPublicationOwner } from ${JSON.stringify(ownerModule)}
const signals = ['SIGHUP', 'SIGINT', 'SIGTERM']
const before = signals.map(signal => process.listenerCount(signal))
try {
  await withEditorPublicationOwner({ root: ${JSON.stringify(root)}, run: async owner => {
    try {
      await withPublicationCancellation({ run: signal => runManagedEditorPublicationCommand({
        native: ${JSON.stringify(native)}, owner,
        env: { JOINED: ${JSON.stringify(joined)}, CHILD_PID: ${JSON.stringify(childPid)} },
        command: { command: 'buck', cwd: ${JSON.stringify(root)},
          args: ['--isolation-dir', editorPublicationIsolation, 'kill'], signal,
          onStderr: text => { if (text.includes('ready')) process.stdout.write('ready') },
        },
      }).then(() => {}) })
      throw new Error('cancellation was lost')
    } catch (error) {
      if (!existsSync(${JSON.stringify(joined)})) throw new Error('owner returned before descendant joined')
      if (error.message !== 'Editor publication interrupted by SIGTERM' && error.signal !== 'SIGTERM')
        throw error
    }
  } })
  if (signals.some((signal, index) => process.listenerCount(signal) !== before[index]))
    throw new Error('cancellation handlers leaked')
  process.stdout.write('joined')
} catch (error) { console.error(error); process.exitCode = 1 }
`
    const child = spawn(process.execPath, ['-e', driver], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    try {
      const [ready] = await once(child.stdout, 'data')
      expect(ready.toString()).toBe('ready')
      child.kill('SIGTERM')
      const [code, signal] = await closed
      expect({ code, signal, stderr }).toEqual({ code: 143, signal: null, stderr: '' })
      expect(readFileSync(joined, 'utf8')).toBe('joined')
      const pid = Number(readFileSync(childPid, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
      rmSync(root, { recursive: true, force: true })
    }
  })
})

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
