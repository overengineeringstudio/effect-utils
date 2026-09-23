import { describe, expect, it } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodePublicationPackagePaths,
  editorViewPackagePaths,
  editorViewPlan,
  resolveEditorViewPackageScope,
} from './editor-view-authority.ts'

describe('editor view authority orchestration', () => {
  it('derives one deterministic editor publication entry per workspace consumer', () => {
    const plan = editorViewPlan({ cell: 'workspace_cell' })

    expect(plan.packages.map(({ packagePath }) => packagePath)).toEqual(editorViewPackagePaths)
    expect(plan.packages).toHaveLength(40)
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
