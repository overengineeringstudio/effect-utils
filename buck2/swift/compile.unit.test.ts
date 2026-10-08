import { describe, expect, it } from 'vitest'

import { swiftCompileCommand } from './compile.ts'

describe('Swift action module-cache contract', () => {
  it('puts the command-line cache and both compiler caches inside Buck action scratch', () => {
    const scratch = 'buck-out/tmp/swift_app_bundle_compile/tray'
    const result = swiftCompileCommand({
      compiler: '/nix/store/compiler/bin/swiftc',
      arguments: ['-sdk', '/nix/store/sdk', '-o', 'tray', 'tray.swift'],
      environment: {
        BUCK_SCRATCH_PATH: scratch,
        CLANG_MODULE_CACHE_PATH: '/Users/example/Library/Caches/clang',
        SWIFT_MODULECACHE_PATH: '/Users/example/Library/Caches/swift',
      },
    })
    expect(result.command.slice(1, 3)).toEqual(['-module-cache-path', `${scratch}/modules`])
    expect(result.environment.CLANG_MODULE_CACHE_PATH).toBe(`${scratch}/modules`)
    expect(result.environment.SWIFT_MODULECACHE_PATH).toBe(`${scratch}/modules`)
    expect([...result.command, ...Object.values(result.environment)].join('\n')).not.toContain('Library/Caches')
  })

  it('fails closed rather than falling back to an ambient cache without action scratch', () => {
    expect(() => swiftCompileCommand({
      compiler: '/nix/store/compiler/bin/swiftc', arguments: [], environment: {},
    })).toThrow()
  })

  it.each([
    ['-module-cache-path', '/Users/example/Library/Caches'],
    ['-module-cache-path=/Users/example/Library/Caches'],
    ['-Xcc', '-fmodules-cache-path=/Users/example/Library/Caches'],
  ])('rejects compiler arguments that override the isolated cache: %j', (...arguments_) => {
    expect(() => swiftCompileCommand({
      compiler: '/nix/store/compiler/bin/swiftc', arguments: arguments_,
      environment: { BUCK_SCRATCH_PATH: 'buck-out/tmp/action' },
    })).toThrow()
  })
})
