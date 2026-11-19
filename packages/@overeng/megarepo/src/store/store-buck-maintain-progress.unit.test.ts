import { describe, expect, it } from 'vitest'

import {
  buckMaintainProgressCommandEnvironment,
  validateBuckMaintainRuntimePaths,
} from './store-buck-maintain-progress.ts'

const executable = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-runtime/bin/bun'
const entrypoint = '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-package/libexec/mr.js'

// These synthetic values exercise pure path relations, not filesystem/runtime attestation.
describe('packaged maintenance runtime path contract', () => {
  it('allows separate Bun and entrypoint paths only with the implementation in the entrypoint', () => {
    expect(
      validateBuckMaintainRuntimePaths({ executable, entrypoint, implementation: entrypoint }),
    ).toBeUndefined()
  })

  it('rejects mutable runtimes, mutable entrypoints and implementation imports outside the bundle', () => {
    for (const paths of [
      { executable: '/tmp/bun', entrypoint, implementation: entrypoint },
      { executable, entrypoint: '/tmp/mr.js', implementation: '/tmp/mr.js' },
      { executable, entrypoint, implementation: '/tmp/mutable/store-buck-maintain-progress.ts' },
      {
        executable,
        entrypoint,
        implementation: '/nix/store/cccccccccccccccccccccccccccccccc-other/module.js',
      },
    ]) {
      expect(validateBuckMaintainRuntimePaths(paths)?._tag).toBe('BuckMaintainProgressError')
    }
    expect(
      validateBuckMaintainRuntimePaths({
        executable,
        entrypoint,
        implementation: '/tmp/mutable.ts',
      })?.message,
    ).toContain('bundled')
  })
})

describe('maintenance command environment binding', () => {
  it('normalizes actual command defaults without losing explicit disable overrides', () => {
    const defaults = buckMaintainProgressCommandEnvironment({})
    expect(defaults).toEqual({ st3Binary: 'st3', ptyBinary: 'pty', buck2DaemonOverride: null })
    expect(
      buckMaintainProgressCommandEnvironment({
        MEGAREPO_GC_ST3_BIN: 'st3',
        MEGAREPO_GC_PTY_BIN: 'pty',
      }),
    ).toEqual(defaults)
    for (const name of ['MEGAREPO_GC_ST3_BIN', 'MEGAREPO_GC_PTY_BIN', 'MEGAREPO_GC_BUCK2_BIN']) {
      expect(buckMaintainProgressCommandEnvironment({ [name]: '' })).not.toEqual(defaults)
    }
  })

  it('retains custom command choices in each independent resume input', () => {
    expect(
      buckMaintainProgressCommandEnvironment({
        MEGAREPO_GC_ST3_BIN: '/tools/st3',
        MEGAREPO_GC_PTY_BIN: '/tools/pty',
        MEGAREPO_GC_BUCK2_BIN: '/tools/buck2',
      }),
    ).toEqual({
      st3Binary: '/tools/st3',
      ptyBinary: '/tools/pty',
      buck2DaemonOverride: '/tools/buck2',
    })
  })
})
