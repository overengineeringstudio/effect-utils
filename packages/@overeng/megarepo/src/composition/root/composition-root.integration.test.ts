import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { generateCompositionRoot, type CompositionRootInput } from './composition-root.ts'

const makeInput = (resolvedBuckExecutable: string): CompositionRootInput => ({
  schemaVersion: 1,
  members: [
    {
      memberKey: 'alpha',
      manifest: {
        schemaVersion: 1,
        cell: 'alpha',
        mount: 'repos/alpha',
        projectIgnore: [],
        distOverlays: [],
        capabilities: [],
      },
    },
  ],
  platformHubCell: 'alpha',
  resolvedBuckExecutable,
})

const fakeBuckSource = `#!/bin/sh
if [ "\${FAKE_MODE:-argv}" = signal ]; then
  trap 'exit 23' TERM
  printf 'ready\\n'
  while :; do sleep 0.05; done
fi
printf '%s\\n' "$@" > "$ARGV_FILE"
exit "\${FAKE_EXIT:-0}"
`

const withWrapperFixture = async <T>(
  run: (fixture: {
    readonly wrapper: string
    readonly workspaceRoot: string
    readonly argvFile: string
    readonly env: NodeJS.ProcessEnv
  }) => Promise<T> | T,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'megarepo-composition-wrapper-'))
  try {
    const fakeDirectory = join(directory, "fake buck's directory")
    const fakeBuck = join(fakeDirectory, "buck2's fake")
    const wrapper = join(directory, '.megarepo', 'bin', 'buck2')
    const argvFile = join(directory, 'argv')
    await mkdir(fakeDirectory)
    await mkdir(join(directory, '.megarepo', 'bin'), { recursive: true })
    await writeFile(fakeBuck, fakeBuckSource)
    await chmod(fakeBuck, 0o755)
    const generated = generateCompositionRoot(makeInput(fakeBuck))
    const wrapperFile = generated.files.find((file) => file.path === '.megarepo/bin/buck2')!
    expect(wrapperFile.mode).toBe(0o755)
    await writeFile(wrapper, wrapperFile.bytes)
    await chmod(wrapper, wrapperFile.mode)
    return await run({
      wrapper,
      workspaceRoot: directory,
      argvFile,
      env: { ...process.env, ARGV_FILE: argvFile },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('generated Buck wrapper', () => {
  it('execs the exact resolved executable with fixed isolation and unchanged user argv', () =>
    withWrapperFixture(async ({ wrapper, argvFile, env }) => {
      const result = spawnSync(wrapper, ['build', 'alpha//:target with space', '--verbose'], {
        env,
        encoding: 'utf8',
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(await readFile(argvFile, 'utf8')).toBe(
        '--isolation-dir\nmegarepo\nbuild\nalpha//:target with space\n--verbose\n',
      )
    }))

  it('resolves a relative external symlink chain and refuses Buck while update-locked', () =>
    withWrapperFixture(async ({ workspaceRoot, argvFile, env }) => {
      const externalDirectory = join(workspaceRoot, 'external-links')
      const nestedDirectory = join(externalDirectory, 'nested')
      const externalWrapper = join(externalDirectory, 'buck2')
      await mkdir(nestedDirectory, { recursive: true })
      await symlink('nested/buck2', externalWrapper)
      await symlink('../../.megarepo/bin/buck2', join(nestedDirectory, 'buck2'))
      const lockPath = join(workspaceRoot, '.megarepo', 'workspace-update.lock')
      await writeFile(lockPath, '{malformed-but-present}\n')
      const result = spawnSync(externalWrapper, ['build', 'alpha//:target'], {
        cwd: tmpdir(),
        env,
        encoding: 'utf8',
      })
      expect(result.status).toBe(75)
      expect(result.stderr).toContain(`workspace update lock exists at ${lockPath}`)
      expect(result.stderr).toContain('through mr')
      await expect(readFile(argvFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }))

  it('passes through the exact Buck exit status', () =>
    withWrapperFixture(({ wrapper, env }) => {
      const result = spawnSync(wrapper, ['targets', 'alpha//...'], {
        env: { ...env, FAKE_EXIT: '37' },
        encoding: 'utf8',
      })
      expect(result.status).toBe(37)
      expect(result.signal).toBeNull()
    }))

  it.each([
    ['separate form', ['--isolation-dir', 'other']],
    ['equals form', ['--isolation-dir=other']],
    ['after command', ['build', '--isolation-dir=other', 'alpha//:target']],
  ])('rejects user isolation flags in %s before Buck runs', (_name, args) =>
    withWrapperFixture(async ({ wrapper, argvFile, env }) => {
      const result = spawnSync(wrapper, args, { env, encoding: 'utf8' })
      expect(result.status).toBe(64)
      expect(result.stderr).toBe('megarepo buck2 wrapper: --isolation-dir is fixed to megarepo\n')
      await expect(readFile(argvFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }),
  )

  it('uses exec so a signal reaches Buck and its resulting status is preserved', () =>
    withWrapperFixture(
      ({ wrapper, env }) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(wrapper, ['build', 'alpha//:target'], {
            env: { ...env, FAKE_MODE: 'signal' },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stderr = ''
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk
          })
          child.once('error', reject)
          child.stdout.once('data', () => {
            child.kill('SIGTERM')
          })
          child.once('close', (code, signal) => {
            try {
              expect(code).toBe(23)
              expect(signal).toBeNull()
              expect(stderr).toBe('')
              resolve()
            } catch (cause) {
              reject(cause)
            }
          })
        }),
    ))
})
