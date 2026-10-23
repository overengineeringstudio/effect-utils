import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  buckClientHoldsWorktree,
  buckClientProjectRoot,
  buckProcessMemoryKiB,
  decideBuckDaemon,
  recognizeBuckDaemon,
} from './store-buck-daemons.ts'
import type { ProcessReference } from './store-inuse.ts'
import { isInsideWorktree } from './store-inuse.ts'
import { excludeActivityProcessLifetimes } from './store-workspace-activity.ts'

const argv = [
  '/nix/store/pinned/libexec/buck2',
  '--isolation-dir',
  'editor',
  'daemon',
  '--daemon-id',
  'daemon-123',
]
const daemon = {
  pid: 123,
  daemonId: 'daemon-123',
  isolation: 'editor',
  root: '/scratch/root',
  path: '/scratch/root/buck-out/editor',
}

describe('Buck2 worktree shutdown policy', () => {
  it('recognizes the root and isolation from a live daemon cwd', () => {
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: daemon.path })).toEqual({
      ...daemon,
      cwdDeleted: false,
    })
  })

  it('recognizes a daemon whose cwd remains at the project root', () => {
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: daemon.root })).toEqual({
      ...daemon,
      path: daemon.root,
      cwdDeleted: false,
    })
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: `${daemon.root} (deleted)` })).toEqual({
      ...daemon,
      path: daemon.root,
      cwdDeleted: true,
    })
  })

  it('recognizes a deleted cwd without treating its marker as part of the root', () => {
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: `${daemon.path} (deleted)` })).toEqual({
      ...daemon,
      cwdDeleted: true,
    })
  })

  it('rejects clients, forkservers, missing flags and non-absolute cwd', () => {
    for (const args of [
      argv.filter((arg) => arg !== 'daemon'),
      [argv[0]!, 'forkserver'],
      ['buck2', 'daemon'],
      argv.slice(0, -1),
      ['buck2', '--isolation-dir', '--daemon-id', 'x', 'daemon'],
    ]) {
      expect(recognizeBuckDaemon({ pid: 123, argv: args, cwd: daemon.path })).toBeUndefined()
    }
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: 'relative/path' })).toBeUndefined()
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd: '/buck-out/editor' })).toBeUndefined()
  })

  it('leaves other absolute cwd forms to the root-scoped status identity check', () => {
    const cwd = '/scratch/root/buck-out/other'
    expect(recognizeBuckDaemon({ pid: 123, argv, cwd })).toEqual({
      ...daemon,
      root: cwd,
      path: cwd,
      cwdDeleted: false,
    })
  })

  it('shares the in-use probe containment boundaries, including nested Buck roots', () => {
    expect(isInsideWorktree({ candidate: daemon.path, worktreePath: '/scratch/root/' })).toBe(true)
    expect(
      isInsideWorktree({
        candidate: '/scratch/root/nested/buck-out/editor',
        worktreePath: '/scratch/root',
      }),
    ).toBe(true)
    expect(
      isInsideWorktree({
        candidate: '/scratch/root-sibling/buck-out/editor',
        worktreePath: '/scratch/root',
      }),
    ).toBe(false)
  })

  it('does not hold an unrelated project using the same default isolation', () => {
    expect(
      buckClientHoldsWorktree({
        cwd: '/scratch/unrelated/packages/app',
        root: '/scratch/unrelated',
        isolation: 'v2',
        worktree: '/scratch/root',
        daemons: [{ ...daemon, isolation: 'v2' }],
      }),
    ).toBe(false)
  })

  it('requires both project root and isolation for clients outside the worktree gate', () => {
    for (const [root, isolation, expected] of [
      [daemon.root, 'editor', true],
      [daemon.root, 'v2', false],
      ['/scratch/unrelated', 'editor', false],
    ] as const) {
      expect(
        buckClientHoldsWorktree({
          cwd: '/scratch/outside',
          root,
          isolation,
          worktree: '/scratch/root',
          daemons: [daemon],
        }),
      ).toBe(expected)
    }
  })

  it('preserves the client cwd worktree gate regardless of daemon identity', () => {
    expect(
      buckClientHoldsWorktree({
        cwd: '/scratch/root/packages/app',
        root: '/scratch/other',
        isolation: 'different',
        worktree: '/scratch/root',
        daemons: [daemon],
      }),
    ).toBe(true)
  })

  it('fails closed when client root or isolation cannot be established', () => {
    for (const [root, isolation] of [
      [undefined, 'editor'],
      ['/scratch/unrelated', undefined],
    ] as const) {
      expect(
        buckClientHoldsWorktree({
          cwd: '/scratch/outside',
          root,
          isolation,
          worktree: '/scratch/root',
          daemons: [daemon],
        }),
      ).toBe(true)
    }
  })

  it('resolves nested cwd to the outermost config up to the buckroot boundary', () => {
    const root = buckClientProjectRoot({
      ancestors: [
        { path: '/scratch/root/packages/app', buckconfig: false, buckroot: false },
        { path: '/scratch/root/packages', buckconfig: true, buckroot: false },
        { path: '/scratch/root', buckconfig: true, buckroot: true },
        { path: '/scratch', buckconfig: true, buckroot: false },
      ],
      homeDirectory: '/home/user',
    })
    expect(root).toBe(daemon.root)
    expect(
      buckClientHoldsWorktree({
        cwd: '/scratch/outside',
        root,
        isolation: 'editor',
        worktree: '/scratch/root',
        daemons: [daemon],
      }),
    ).toBe(true)
  })

  it('does not mistake a nested buckroot or HOME config override for the outer project', () => {
    expect(
      buckClientProjectRoot({
        ancestors: [
          { path: '/scratch/root/nested/app', buckconfig: false, buckroot: false },
          { path: '/scratch/root/nested', buckconfig: true, buckroot: true },
          { path: '/scratch/root', buckconfig: true, buckroot: true },
        ],
        homeDirectory: '/home/user',
      }),
    ).toBe('/scratch/root/nested')
    expect(
      buckClientProjectRoot({
        ancestors: [
          { path: '/home/user/project', buckconfig: true, buckroot: false },
          { path: '/home/user', buckconfig: true, buckroot: false },
          { path: '/home', buckconfig: true, buckroot: false },
        ],
        homeDirectory: '/home/user',
      }),
    ).toBe('/home/user/project')
    expect(
      buckClientProjectRoot({
        ancestors: [{ path: '/scratch/no-config', buckconfig: false, buckroot: true }],
        homeDirectory: '/home/user',
      }),
    ).toBeUndefined()
  })

  it('stops only the identical idle daemon', () => {
    expect(
      decideBuckDaemon({
        daemon,
        status: {
          process_info: { pid: 123 },
          daemon_constraints: { daemon_id: 'daemon-123' },
          active_commands: [],
        },
      }),
    ).toBe('stop')
    expect(
      decideBuckDaemon({
        daemon,
        status: {
          process_info: { pid: 123 },
          daemon_constraints: { daemon_id: 'daemon-123' },
          active_commands: [{}],
        },
      }),
    ).toBe('kept-active')
    expect(
      decideBuckDaemon({
        daemon,
        status: {
          process_info: { pid: 124 },
          daemon_constraints: { daemon_id: 'daemon-123' },
          active_commands: [],
        },
      }),
    ).toBe('identity-mismatch')
    expect(
      decideBuckDaemon({
        daemon,
        status: {
          process_info: { pid: 123 },
          daemon_constraints: { daemon_id: 'replacement' },
          active_commands: [],
        },
      }),
    ).toBe('identity-mismatch')
  })

  it('sums RSS and swap but not virtual size', () => {
    expect(buckProcessMemoryKiB('VmSize:\t9999 kB\nVmRSS:\t1234 kB\nVmSwap:\t56 kB\n')).toBe(1290)
    expect(buckProcessMemoryKiB('State:\tZ (zombie)\n')).toBe(0)
  })

  it('defers only recognized lifetimes, preserving other holders of the same path', () => {
    const references = [
      { pid: 123, kind: 'cwd', path: daemon.path },
      { pid: 124, kind: 'fd', path: daemon.path },
    ] satisfies ReadonlyArray<ProcessReference>
    expect(
      excludeActivityProcessLifetimes({
        references,
        observed: [
          { pid: 123, startTime: '100' },
          { pid: 124, startTime: '101' },
        ],
        ignored: [{ pid: 123, startTime: '100' }],
      }),
    ).toEqual([references[1]])
  })

  it('does not waive activity when a PID is reused or its lifetime is unknown', () => {
    const references = [
      { pid: 123, kind: 'cwd', path: daemon.path },
    ] satisfies ReadonlyArray<ProcessReference>
    for (const observed of [[{ pid: 123, startTime: '200' }], []]) {
      expect(
        excludeActivityProcessLifetimes({
          references,
          observed,
          ignored: [{ pid: 123, startTime: '100' }],
        }),
      ).toEqual(references)
    }
  })

  it('leaves ordinary budget activity scans unchanged without exclusions', () => {
    const references = [
      { pid: 123, kind: 'cwd', path: daemon.path },
    ] satisfies ReadonlyArray<ProcessReference>
    expect(excludeActivityProcessLifetimes({ references, observed: [] })).toBe(references)
    expect(excludeActivityProcessLifetimes({ references, observed: [], ignored: [] })).toBe(
      references,
    )
  })
})
