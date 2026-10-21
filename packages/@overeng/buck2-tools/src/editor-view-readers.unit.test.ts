import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as Leases from './editor-view-leases.ts'
import {
  classifyEditorViewProcessCandidates,
  editorViewAutomaticEvictionEvidence,
  measureEditorViewReaders,
  observeEditorViewProcessCandidates,
} from './editor-view-readers.ts'

// Permission errors, PID reuse and truncated native-tool output cannot be
// generated deterministically with real host processes in a unit test.
const nativeFs = { ...Fs }
const nativeChildProcess = { ...ChildProcess }
const nativeLeases = { ...Leases }
const io = {
  readdirSync: vi.fn(),
  lstatSync: vi.fn(),
  statSync: vi.fn(),
  readlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  spawnSync: vi.fn(),
  probeEditorViewLease: vi.fn(),
  releaseLeaseProbe: vi.fn(),
}
// Match the suite's stable forwarding-export mocks; Bun's Vitest shim does not
// implement vi.hoisted or global resetAllMocks.
vi.mock('node:fs', () => ({ ...nativeFs, ...io }))
vi.mock('node:child_process', () => ({ ...nativeChildProcess, spawnSync: io.spawnSync }))
vi.mock('./editor-view-leases.ts', () => ({
  ...nativeLeases,
  probeEditorViewLease: io.probeEditorViewLease,
}))

const candidates = [
  { key: 'a', editorRoot: '/views', snapshotRoot: '/views/.store/a', linkedInodes: ['1:42'] },
  { key: 'b', editorRoot: '/views', snapshotRoot: '/views/.store/b', linkedInodes: [] },
  { key: 'c', editorRoot: '/other', snapshotRoot: '/other/.store/c', linkedInodes: [] },
]
const platform = process.platform
const uid = process.getuid?.() ?? 1000
const denied = (code = 'EACCES'): Error => Object.assign(new Error(code), { code })
const incarnation = (start = '100'): string =>
  `1 (fixture) S ${Array(18).fill('0').join(' ')} ${start}`

beforeEach(() => {
  for (const mock of Object.values(io)) mock.mockReset()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  io.readdirSync.mockImplementation((path: string) => (path === '/proc' ? ['123'] : []))
  io.lstatSync.mockReturnValue({ uid })
  io.readlinkSync.mockReturnValue('/unrelated')
  io.statSync.mockReturnValue({ isFile: () => true, ino: 0n, dev: 0n })
  io.readFileSync.mockImplementation((path: string) =>
    path.endsWith('/stat') ? incarnation() : '',
  )
  io.spawnSync.mockReturnValue({ stdout: '', stderr: '', status: 1, signal: null })
  io.probeEditorViewLease.mockReturnValue({
    state: 'clear',
    reasons: [],
    release: io.releaseLeaseProbe,
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  io.readdirSync.mockReset().mockImplementation(nativeFs.readdirSync)
  io.lstatSync.mockReset().mockImplementation(nativeFs.lstatSync)
  io.statSync.mockReset().mockImplementation(nativeFs.statSync)
  io.readlinkSync.mockReset().mockImplementation(nativeFs.readlinkSync)
  io.readFileSync.mockReset().mockImplementation(nativeFs.readFileSync)
  io.realpathSync.mockReset().mockImplementation(nativeFs.realpathSync)
  io.spawnSync.mockReset().mockImplementation(nativeChildProcess.spawnSync)
  io.probeEditorViewLease.mockReset().mockImplementation(nativeLeases.probeEditorViewLease)
})

const classify = () => classifyEditorViewProcessCandidates({ candidates })

describe('migration reader evidence', () => {
  it('classifies a complete unrelated same-user process clear without namespace heuristics', () => {
    expect([...classify().values()].map(({ state }) => state)).toEqual(['clear', 'clear', 'clear'])
    expect(io.readlinkSync.mock.calls.some(([path]) => String(path).includes('/ns/'))).toBe(false)
  })

  it('excludes foreign uid before any ptrace-gated reads', () => {
    io.lstatSync.mockReturnValue({ uid: uid + 1 })
    expect(classify().get('a')?.state).toBe('clear')
    expect(io.readlinkSync).not.toHaveBeenCalled()
  })

  it('fails closed on proc enumeration and identity failures', () => {
    io.readdirSync.mockImplementation(() => {
      throw denied('EIO')
    })
    expect(classify().get('a')).toEqual({
      state: 'unknown',
      reasons: ['proc-enumeration: /proc: EIO'],
    })
    io.readdirSync.mockReturnValue(['123'])
    io.lstatSync.mockImplementation(() => {
      throw denied('ENOENT')
    })
    expect(classify().get('a')?.reasons[0]).toContain('proc-identity')
  })

  it.each(['cwd', 'root', 'exe', 'fd', 'maps', 'cmdline'])(
    'denied %s blocks every possibly reachable root',
    (entry) => {
      const path = `/proc/123/${entry}`
      if (entry === 'fd')
        io.readdirSync.mockImplementation((input: string) => {
          if (input === path) throw denied()
          return ['123']
        })
      else if (entry === 'maps' || entry === 'cmdline')
        io.readFileSync.mockImplementation((input: string) => {
          if (input === path) throw denied()
          return input.endsWith('/stat') ? incarnation() : ''
        })
      else
        io.readlinkSync.mockImplementation((input: string) => {
          if (input === path) throw denied()
          return '/unrelated'
        })
      for (const evidence of classify().values()) {
        expect(evidence.state).toBe('unknown')
        expect(evidence.reasons.join()).toContain(path)
      }
      expect(observeEditorViewProcessCandidates({ candidates })).toEqual(new Set(['a', 'b', 'c']))
    },
  )

  it('does not excuse a closed descriptor while its process incarnation remains live', () => {
    io.readdirSync.mockImplementation((path: string) => (path === '/proc' ? ['123'] : ['4']))
    io.readlinkSync.mockImplementation((path: string) => {
      if (path.endsWith('/fd/4')) throw denied('ENOENT')
      return '/unrelated'
    })
    expect(classify().get('a')?.state).toBe('unknown')
  })

  it.each(['exit', 'reuse'])('excuses vanished links only after proving incarnation %s', (mode) => {
    let reads = 0
    io.readlinkSync.mockImplementation(() => {
      throw denied('ENOENT')
    })
    io.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/stat') === false) return ''
      if (++reads === 1) return incarnation()
      if (mode === 'exit') throw denied('ESRCH')
      return incarnation('101')
    })
    expect(classify().get('a')?.state).toBe(mode === 'exit' ? 'clear' : 'unknown')
  })

  it('does not excuse EACCES even when the process subsequently exits', () => {
    let reads = 0
    io.readlinkSync.mockImplementation(() => {
      throw denied()
    })
    io.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/stat') === false) return ''
      if (++reads === 1) return incarnation()
      throw denied('ENOENT')
    })
    expect(classify().get('a')?.state).toBe('unknown')
  })

  it('preserves candidate-specific positive paths while unrelated failures remain unknown', () => {
    io.readlinkSync.mockImplementation((path: string) => {
      if (path.endsWith('/cwd')) return '/views/.store/a/node_modules/pkg'
      throw denied()
    })
    const result = classify()
    expect(result.get('a')?.state).toBe('held')
    expect(result.get('b')?.state).toBe('unknown')
    expect(result.get('c')?.state).toBe('unknown')
  })

  it('recognizes bind/outside descriptor aliases by inode, independent of cwd/root names', () => {
    io.readdirSync.mockImplementation((path: string) => (path === '/proc' ? ['123'] : ['4']))
    io.statSync.mockReturnValue({ isFile: () => true, ino: 42n, dev: 1n })
    expect(classify().get('a')?.state).toBe('held')
    expect(classify().get('b')?.state).toBe('clear')
  })

  it('recognizes mapping aliases by inode and rejects malformed maps', () => {
    io.readFileSync.mockImplementation((path: string) =>
      path.endsWith('/stat')
        ? incarnation()
        : path.endsWith('/maps')
          ? '100-200 r--p 0000 00:01 42 /alias\n'
          : '',
    )
    expect(classify().get('a')?.state).toBe('held')
    io.readFileSync.mockImplementation((path: string) =>
      path.endsWith('/stat') ? incarnation() : 'truncated',
    )
    expect(classify().get('a')?.state).toBe('unknown')
  })

  it('marks an unsupported platform unknown', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
    expect(classify().get('a')?.reasons).toEqual(['unsupported-process-platform: freebsd'])
  })

  it('keeps policy unknown even with a completely clear migration census', () => {
    expect(classify().get('a')?.state).toBe('clear')
    expect(editorViewAutomaticEvictionEvidence({ editorRoot: '/views' })).toMatchObject({
      state: 'unknown',
    })
    expect(editorViewAutomaticEvictionEvidence({ editorRoot: '/views' }).reasons.join()).toContain(
      'unmanaged-editor-sessions',
    )
    expect(editorViewAutomaticEvictionEvidence({ editorRoot: '/views' }).reasons.join()).toContain(
      'presumed unmanaged sessions, not scan-detected',
    )
    expect(editorViewAutomaticEvictionEvidence({ editorRoot: '/views' }).reasons.join()).toContain(
      '#1985',
    )
  })
})

describe('macOS lsof completeness', () => {
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }),
  )

  it('accepts documented empty selection without diagnostics', () => {
    expect(classify().get('a')?.state).toBe('clear')
  })

  it.each([
    { error: denied('ENOENT') },
    { error: denied('ENOBUFS') },
    { status: 2 },
    { status: null, signal: 'SIGKILL' },
    { stderr: 'permission denied' },
    { status: 1, stdout: `p123\0u${uid}\0` },
    { status: 0, stdout: 'p123' },
  ])('fails closed on failed/partial native results: %j', (change) => {
    io.spawnSync.mockReturnValue({ stdout: '', stderr: '', status: 1, signal: null, ...change })
    expect(classify().get('a')?.state).toBe('unknown')
  })

  it('retains positive references even when the remaining output failed', () => {
    io.spawnSync.mockReturnValue({
      stdout: `p123\0u${uid}\0fcwd\0tDIR\0n/views/.store/a\0\n`,
      stderr: 'incomplete scan',
      status: 2,
      signal: null,
    })
    expect(classify().get('a')?.state).toBe('held')
    expect(classify().get('b')?.state).toBe('unknown')
  })

  it('matches external hardlink spellings by device/inode', () => {
    io.spawnSync.mockReturnValue({
      stdout: `p123\0u${uid}\0f4\0tREG\0D0x1\0i42\0n/alias\0\n`,
      stderr: '',
      status: 0,
      signal: null,
    })
    expect(classify().get('a')?.state).toBe('held')
    expect(classify().get('b')?.state).toBe('clear')
  })

  it('reports a throwing native spawn as unknown', () => {
    io.spawnSync.mockImplementation(() => {
      throw denied('ENOMEM')
    })
    expect(classify().get('a')?.reasons.join()).toContain('lsof-spawn: ENOMEM')
  })

  it.each([
    `p123\0fcwd\0tDIR\0n/alias\0\n`,
    `p123\0u${uid}\0f4\0n/alias\0\n`,
    `p123\0u${uid}\0f4\0tREG\0n/alias\0\n`,
  ])('rejects incomplete file/identity records', (stdout) => {
    io.spawnSync.mockReturnValue({ stdout, stderr: '', status: 0, signal: null })
    expect(classify().get('a')?.state).toBe('unknown')
  })
})

describe('read-only measurement', () => {
  it('reports inventory failure instead of claiming an empty clear root', async () => {
    io.readdirSync.mockImplementation(() => {
      throw denied()
    })
    const report = await measureEditorViewReaders({ editorRoots: ['/views'] })
    expect(report.roots[0]?.reasons.join()).toContain('root-inventory: /views: EACCES')
    expect(report.roots[0]?.policy.state).toBe('unknown')
  })

  it('separates raw clear evidence from unknown policy and counts persistent control metadata', async () => {
    io.readdirSync.mockImplementation((path: string) => {
      if (path === '/proc') return ['123']
      if (path === '/views/.leases') return ['a.lock', 'retired.lock']
      if (path === '/views/.store')
        return [`view-${'a'.repeat(64)}`, '.candidate', 'not-a-generation']
      return []
    })
    io.lstatSync.mockImplementation((path: string) => ({
      uid,
      size: path.endsWith('.lock') ? 0 : 4096,
      blocks: 8,
      isDirectory: () => path.endsWith('.lock') === false,
      isFile: () => path.endsWith('.lock'),
    }))
    const report = await measureEditorViewReaders({ editorRoots: ['/views'] })
    expect(report.automaticEviction).toEqual({
      eligibleRoots: 0,
      noAutomaticEvictionRoots: 1,
      presumedUnmanagedRoots: 1,
    })
    expect(report.roots[0]?.leaseControlInodes).toBe(2)
    expect(report.roots[0]?.leaseControlDirectoryInodes).toBe(1)
    expect(report.roots[0]?.leaseControlMetadataBytes).toBe(12288)
    expect(report.generations).toHaveLength(1)
    expect(io.releaseLeaseProbe).toHaveBeenCalledOnce()
    expect(report.generations[0]?.observed.state).toBe('clear')
    expect(report.generations[0]?.effective.state).toBe('unknown')
  })

  it('merges lease holders with unknown legacy evidence and releases EX probe handles', async () => {
    io.readdirSync.mockImplementation((path: string) => {
      if (path === '/proc') throw denied()
      if (path === '/views/.store') return [`view-${'a'.repeat(64)}`]
      return []
    })
    io.lstatSync.mockReturnValue({ uid, size: 4096, blocks: 8, isDirectory: () => true })
    io.probeEditorViewLease.mockReturnValue({
      state: 'held',
      reasons: ['shared lease held'],
      release: io.releaseLeaseProbe,
    })
    const report = await measureEditorViewReaders({ editorRoots: ['/views'] })
    expect(report.generations[0]?.legacy.state).toBe('unknown')
    expect(report.generations[0]?.lease.state).toBe('held')
    expect(report.generations[0]?.observed.state).toBe('held')
    expect(report.generations[0]?.effective.state).toBe('held')
    expect(report.roots[0]?.observed.state).toBe('held')
    expect(io.releaseLeaseProbe).toHaveBeenCalledOnce()
  })
})
