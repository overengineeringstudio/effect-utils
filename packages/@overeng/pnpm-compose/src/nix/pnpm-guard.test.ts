/**
 * Tests for the pnpm guard overlay.
 *
 * These tests verify the Nix overlay is properly exported and the wrapper
 * script logic is correct.
 */
import { Command, FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

const TestLayer = NodeContext.layer

describe('pnpm guard overlay', () => {
  it.effect('exports pnpmGuard overlay from flake', () =>
    Effect.gen(function* () {
      const flakePath = new URL('../../flake.nix', import.meta.url).pathname
      const dir = flakePath.replace('/flake.nix', '')

      // Check that the overlay is exported
      const command = Command.make(
        'nix',
        'eval',
        `path:${dir}#overlays`,
        '--apply',
        'x: builtins.attrNames x',
        '--json',
      )
      const output = yield* Command.string(command)
      const overlays = JSON.parse(output.trim()) as string[]

      expect(overlays).toContain('default')
      expect(overlays).toContain('pnpmGuard')
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  )

  it.effect('overlay.nix contains pnpm guard wrapper logic', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const overlayPath = new URL('../../nix/overlay.nix', import.meta.url).pathname
      const content = yield* fs.readFileString(overlayPath)

      // Verify key parts of the wrapper are present
      expect(content).toContain('find_compose_root')
      expect(content).toContain('pnpm-compose.config.ts')
      expect(content).toContain('.gitmodules')
      expect(content).toContain('submodules/')
      expect(content).toContain('Cannot run')
      expect(content).toContain('pnpm-compose install')
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  )

  describe('wrapper script logic', () => {
    /**
     * Test the guard logic directly using bash.
     * This mirrors the auto-detection logic in the Nix wrapper.
     *
     * We simulate the directory structure by:
     * - hasConfig: whether pnpm-compose.config.ts exists at root
     * - hasGitmodules: whether .gitmodules exists at root
     * - hasSubmodulesDir: whether submodules/ dir exists at root
     */
    const runGuardCheck = (
      cmd: string,
      cwd: string,
      root: string,
      opts: { hasConfig?: boolean; hasGitmodules?: boolean; hasSubmodulesDir?: boolean } = {},
    ) => {
      const { hasConfig = false, hasGitmodules = false, hasSubmodulesDir = false } = opts

      // Simulate find_compose_root by checking if markers exist
      // In real usage, it walks up directories - here we simulate with flags
      const script = `
        cmd="${cmd}"
        cwd="${cwd}"
        root="${root}"
        has_config="${hasConfig}"
        has_gitmodules="${hasGitmodules}"
        has_submodules_dir="${hasSubmodulesDir}"

        # Simulate find_compose_root result
        found_root=""
        if [[ "$has_config" == "true" ]] || { [[ "$has_gitmodules" == "true" ]] && [[ "$has_submodules_dir" == "true" ]]; }; then
          found_root="$root"
        fi

        if [[ "$cmd" == "install" || "$cmd" == "i" || "$cmd" == "add" ]]; then
          if [[ -n "$found_root" ]]; then
            if [[ "$cwd" != "$found_root" ]] && [[ "$cwd" == "$found_root/submodules/"* ]]; then
              echo "BLOCKED"
              exit 0
            fi
          fi
        fi
        echo "ALLOWED"
      `
      return Command.make('bash', '-c', script)
    }

    it.effect('allows pnpm install in parent directory', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('install', '/repo', '/repo', { hasConfig: true }),
        )
        expect(output.trim()).toBe('ALLOWED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('blocks pnpm install in submodule (with config file)', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('install', '/repo/submodules/lib', '/repo', { hasConfig: true }),
        )
        expect(output.trim()).toBe('BLOCKED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('blocks pnpm install in submodule (with .gitmodules + submodules/)', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('install', '/repo/submodules/lib', '/repo', {
            hasGitmodules: true,
            hasSubmodulesDir: true,
          }),
        )
        expect(output.trim()).toBe('BLOCKED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('blocks pnpm i (shorthand) in submodule', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('i', '/repo/submodules/lib', '/repo', { hasConfig: true }),
        )
        expect(output.trim()).toBe('BLOCKED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('blocks pnpm add in submodule', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('add', '/repo/submodules/lib', '/repo', { hasConfig: true }),
        )
        expect(output.trim()).toBe('BLOCKED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('allows pnpm list in submodule (non-destructive)', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('list', '/repo/submodules/lib', '/repo', { hasConfig: true }),
        )
        expect(output.trim()).toBe('ALLOWED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('allows pnpm install when no marker files found', () =>
      Effect.gen(function* () {
        // No config, no gitmodules - not a pnpm-compose repo
        const output = yield* Command.string(
          runGuardCheck('install', '/repo/submodules/lib', '/repo', {}),
        )
        expect(output.trim()).toBe('ALLOWED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('allows pnpm install with only .gitmodules (no submodules/ dir)', () =>
      Effect.gen(function* () {
        // .gitmodules alone isn't enough - need submodules/ dir too
        const output = yield* Command.string(
          runGuardCheck('install', '/repo/submodules/lib', '/repo', { hasGitmodules: true }),
        )
        expect(output.trim()).toBe('ALLOWED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    it.effect('blocks nested submodule paths', () =>
      Effect.gen(function* () {
        const output = yield* Command.string(
          runGuardCheck('install', '/repo/submodules/lib/submodules/nested', '/repo', {
            hasConfig: true,
          }),
        )
        expect(output.trim()).toBe('BLOCKED')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })
})
