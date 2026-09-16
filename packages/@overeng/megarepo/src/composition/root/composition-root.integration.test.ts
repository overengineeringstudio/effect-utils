import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { reconcileWatchmanProject } from '../apply/composition-runtime.ts'
import { generateCompositionRoot, type CompositionRootInput } from './composition-root.ts'

const makeInput = (
  resolvedBuckExecutable: string,
  projectIgnore: ReadonlyArray<string> = [],
): CompositionRootInput => ({
  schemaVersion: 1,
  members: [
    {
      memberKey: 'alpha',
      manifest: {
        schemaVersion: 1,
        cell: 'alpha',
        mount: 'repos/alpha',
        projectIgnore,
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

const execFile = promisify(execFileCallback)
const watchmanPath = process.env['MR_COMPOSITION_WATCHMAN_BIN'] ?? 'watchman'
const watchmanAvailable = spawnSync(watchmanPath, ['--version'], { stdio: 'ignore' }).status === 0

const watchman = async (...args: ReadonlyArray<string>): Promise<unknown> => {
  const { stdout } = await execFile(watchmanPath, ['--no-pretty', ...args], {
    encoding: 'utf8',
  })
  return JSON.parse(stdout) as unknown
}

const queryWatchmanFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const response = await watchman(
    'query',
    root,
    JSON.stringify({ expression: ['exists'], fields: ['name'] }),
  )
  if (
    typeof response !== 'object' ||
    response === null ||
    !('files' in response) ||
    Array.isArray(response.files) === false
  ) {
    throw new TypeError('Watchman query did not return a file list')
  }
  const files: Array<string> = []
  for (const file of response.files) {
    if (typeof file === 'string') {
      files.push(file)
    } else if (
      typeof file === 'object' &&
      file !== null &&
      'name' in file &&
      typeof file.name === 'string'
    ) {
      files.push(file.name)
    } else {
      throw new TypeError('Watchman query returned a file without a string name')
    }
  }
  return files
}

const writeGeneratedWatchmanConfig = async ({
  root,
  projectIgnore,
}: {
  readonly root: string
  readonly projectIgnore: ReadonlyArray<string>
}): Promise<void> => {
  const generated = generateCompositionRoot(makeInput('/nix/store/fake/bin/buck2', projectIgnore))
  const config = generated.files.find((file) => file.path === '.watchmanconfig')
  if (config === undefined) throw new TypeError('composition did not generate .watchmanconfig')
  await writeFile(join(root, config.path), config.bytes)
}

const withWrapperFixture = async <T>(
  run: (fixture: {
    readonly wrapper: string
    readonly workspaceRoot: string
    readonly argvFile: string
    readonly env: NodeJS.ProcessEnv
  }) => Promise<T> | T,
): Promise<T> => {
  // Root the fixture at the physical temp dir. Composition refuses non-canonical
  // paths on purpose (the private-scratch identity guard compares realpath against
  // the path it was handed), and real callers reach it through paths the store or
  // Git already resolved. On macOS `os.tmpdir()` is under the /var -> /private/var
  // symlink; where nothing above it is a symlink this is the identity.
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'megarepo-composition-wrapper-'))
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

describe('generated Watchman root', () => {
  it.skipIf(watchmanAvailable === false)(
    'owns an exact disposable root across cold recreation and keeps source capabilities visible',
    async () => {
      const parent = await mkdtemp(join(realpathSync(tmpdir()), 'megarepo-watchman-root-'))
      const root = join(parent, 'composition')
      const member = join(root, 'repos', 'alpha')
      try {
        await Promise.all([
          mkdir(join(parent, 'unrelated-sibling', 'large', 'tree'), { recursive: true }),
          mkdir(join(member, 'src'), { recursive: true }),
          mkdir(join(member, '.buck2', 'capabilities'), { recursive: true }),
          mkdir(join(member, 'generated'), { recursive: true }),
          mkdir(join(root, 'buck-out'), { recursive: true }),
        ])
        await Promise.all([
          writeFile(join(parent, 'unrelated-sibling', 'large', 'tree', 'sentinel'), 'unrelated\n'),
          writeFile(join(member, 'src', 'sentinel.ts'), 'export const sentinel = true\n'),
          writeFile(join(member, '.buck2', 'capabilities', 'defs.bzl'), 'TOOLS = {}\n'),
          writeFile(join(member, 'generated', 'ignored.txt'), 'ignored\n'),
          writeFile(join(root, 'buck-out', 'ignored.txt'), 'ignored\n'),
          writeGeneratedWatchmanConfig({ root, projectIgnore: [] }),
        ])

        await reconcileWatchmanProject({ watchmanPath, workspaceRoot: root })
        const watched = await watchman('watch-project', root)
        expect(watched).toMatchObject({ watch: root })
        expect(watched).not.toHaveProperty('relative_path')

        const firstFiles = await queryWatchmanFiles(root)
        expect(firstFiles).toContain('repos/alpha/src/sentinel.ts')
        expect(firstFiles).toContain('repos/alpha/.buck2/capabilities/defs.bzl')
        expect(firstFiles).toContain('repos/alpha/generated/ignored.txt')
        expect(firstFiles).not.toContain('buck-out/ignored.txt')
        expect(firstFiles).not.toContain('../unrelated-sibling/large/tree/sentinel')

        await writeGeneratedWatchmanConfig({ root, projectIgnore: ['generated'] })
        await reconcileWatchmanProject({ watchmanPath, workspaceRoot: root })
        const reconfiguredFiles = await queryWatchmanFiles(root)
        expect(reconfiguredFiles).toContain('repos/alpha/src/sentinel.ts')
        expect(reconfiguredFiles).toContain('repos/alpha/.buck2/capabilities/defs.bzl')
        expect(reconfiguredFiles).not.toContain('repos/alpha/generated/ignored.txt')

        await watchman('watch-del', root)
        await reconcileWatchmanProject({ watchmanPath, workspaceRoot: root })
        const recreated = await watchman('watch-project', root)
        expect(recreated).toMatchObject({ watch: root })
        const recreatedFiles = await queryWatchmanFiles(root)
        expect(recreatedFiles).toContain('repos/alpha/src/sentinel.ts')
        expect(recreatedFiles).toContain('repos/alpha/.buck2/capabilities/defs.bzl')
        expect(recreatedFiles).not.toContain('repos/alpha/generated/ignored.txt')
      } finally {
        await watchman('watch-del', root).catch(() => undefined)
        await rm(parent, { recursive: true, force: true })
      }
    },
  )
})
