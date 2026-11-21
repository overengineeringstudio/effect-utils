import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import {
  runOwnedEditorPublicationCommand,
  stopOwnedEditorPublicationDaemon,
} from '../../../../scripts/buck2-entrypoint.ts'
import { requireEditorPublicationInputs } from './editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
  requireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'
import { publishEditorView, verifyEditorViewSnapshot } from './editor-view.ts'

// Required pinned tools and owner DSO are declared by the integration target.
// Every build uses the real managed native boundary; no descriptors cross it.
const tool = (name: string): string => {
  const value = process.env[name]
  assert(value, `required integration tool: ${name}`)
  assert(realpathSync(value).startsWith('/nix/store/'), `${name} must be Nix-pinned`)
  return value
}
const unlockDirectories = (path: string): void => {
  const status = lstatSync(path)
  if (!status.isDirectory() || status.isSymbolicLink()) return
  chmodSync(path, (status.mode & 0o777) | 0o700)
  for (const name of readdirSync(path)) unlockDirectories(join(path, name))
}
const inventory = (root: string): unknown[] =>
  readdirSync(root)
    .sort()
    .flatMap((name): unknown[] => {
      const path = join(root, name)
      const status = lstatSync(path, { bigint: true })
      return status.isDirectory()
        ? [[path, status.dev, status.ino], ...inventory(path)]
        : [[path, status.dev, status.ino, readFileSync(path).toString('hex')]]
    })

it('keeps private publication inputs intact while default Buck restarts and rematerializes during verify', async () => {
  const repository = fileURLToPath(new URL('../../../..', import.meta.url))
  const scratch = join(repository, 'tmp', 'editor-publication-inputs')
  mkdirSync(scratch, { recursive: true })
  const root = realpathSync(mkdtempSync(join(scratch, 'run-')))
  const buck = tool('BUCK2_BIN')
  const native = tool('BUCK2_NATIVE_BIN')
  tool('BUCK2_EDITOR_PUBLICATION_OWNER_LIBRARY')
  const home = realpathSync(mkdtempSync(join(scratch, 'home-')))
  let privateRetired = true
  let defaultRetired = true
  let failure: { cause: unknown } | undefined
  const stopPrivate = (owner: EditorPublicationOwner): void => {
    const result = stopOwnedEditorPublicationDaemon({
      native,
      cwd: root,
      env: { ...process.env, HOME: home },
      owner,
    })
    if (result.error !== undefined) throw result.error
    assert.equal(result.status, 0, `private daemon stop (${result.signal}): ${result.stderr}`)
    privateRetired = true
  }
  const timings: Record<string, number> = {}
  const started = performance.now()
  const savedBudget = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = join(root, 'host-budget.json')
  const run = async (args: string[], owner?: EditorPublicationOwner): Promise<string> => {
    const env = { ...process.env, HOME: home }
    if (owner !== undefined) {
      privateRetired = false
      const result = await runOwnedEditorPublicationCommand({
        native,
        args,
        cwd: root,
        env,
        owner,
        signal: AbortSignal.timeout(120_000),
        stdin: 'ignore',
      })
      if (result.exitCode !== 0 || result.signalCode !== null)
        throw new Error(
          `Owned Buck ${args.join(' ')} failed (${result.signalCode ?? result.exitCode}): ${result.stderr}`,
        )
      return result.stdout
    }
    defaultRetired = false
    const child = spawn(buck, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const exited = Promise.withResolvers<void>()
    let failure: Error | undefined
    child.once('error', (cause) => {
      failure = cause
    })
    child.once('close', (code, signal) => {
      if (failure !== undefined) exited.reject(failure)
      else if (code === 0) exited.resolve()
      else exited.reject(new Error(`Buck ${args.join(' ')} failed (${code ?? signal}): ${stderr}`))
    })
    await exited.promise
    if (args[0] === 'kill') defaultRetired = true
    return stdout
  }
  const measured = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    try {
      return await action()
    } finally {
      timings[name] = performance.now() - start
    }
  }
  const build = async (owner?: EditorPublicationOwner): Promise<string> => {
    const selection = owner === undefined ? [] : ['--isolation-dir', editorPublicationIsolation]
    const result: unknown = JSON.parse(
      await run([...selection, 'build', '--show-full-json-output', '//:inputs'], owner),
    )
    assert(result !== null && typeof result === 'object')
    const outputs = Object.values(result)
    assert(outputs.length === 1 && typeof outputs[0] === 'string')
    return outputs[0]
  }
  try {
    writeFileSync(join(root, '.buckroot'), '')
    // The owning task retains this immutable cell in its declared closure.
    const storeFixture = realpathSync(tool('BUCK2_EDITOR_PUBLICATION_FIXTURE'))
    writeFileSync(
      join(root, '.buckconfig'),
      `[cells]\nfixture = .\nrules = ${storeFixture}\n[buck2]\nfile_watcher = fs_hash_crawler\nremote_cache_enabled = false\n`,
    )
    writeFileSync(
      join(root, 'BUCK'),
      'load("rules//:inputs.bzl", "inputs")\ninputs(name = "inputs")\n',
    )
    writeFileSync(join(root, 'package.json'), '{}\n')
    const immutableInput = realpathSync(tool('BUN_BIN'))
    expect(() => requireEditorPublicationInputs({ root, paths: [immutableInput] })).not.toThrow()
    const immutableCarrier = join(root, 'buck-out', 'v2', 'immutable-carrier')
    mkdirSync(dirname(immutableCarrier), { recursive: true })
    symlinkSync(immutableInput, immutableCarrier)
    expect(() => requireEditorPublicationInputs({ root, paths: [immutableCarrier] })).toThrow()
    const authority = join(root, 'workspace-authority.json')
    writeFileSync(
      authority,
      JSON.stringify({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: ['.'],
        ownedPackages: ['.'],
      }),
    )
    const defaultOutput = await measured('coldDefaultBuildMs', () => build())
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        let publicationFailure: { cause: unknown } | undefined
        try {
          const output = await measured('coldPrivateBuildMs', () => build(owner))
          expect(output).toContain(`/buck-out/${editorPublicationIsolation}/`)
          expect(output).not.toBe(defaultOutput)
          const before = inventory(output)
          let reachedVerify = false
          const options = {
            repoRoot: root,
            package: '.',
            viewName: 'root',
            cell: 'fixture',
            target: '//:inputs',
            publicationOwner: owner,
            editorInputs: join(output, 'editor_inputs'),
            nodeModules: join(output, 'node_modules'),
            backingRoots: [join(output, 'node_modules')],
            workspaceAuthority: authority,
            cp: tool('CP_BIN'),
            mv: tool('MV_BIN'),
            fingerprintTool: tool('FINGERPRINT_BIN'),
            consumerCache: join(root, '.devenv', 'vite-cache'),
            snapshotRetention: 2,
            snapshotGraceMs: 0,
            contentStore: join(root, 'content', 'v1'),
            admissionDirectory: join(root, 'fingerprint-admission'),
            beforeVerify: async () =>
              measured('verifyBarrierMs', async () => {
                reachedVerify = true
                expect(
                  requireEditorPublicationOwner({
                    root,
                    owner,
                  }),
                ).toBe(owner)
                await measured('defaultDaemonStopMs', () => run(['kill']))
                unlockDirectories(defaultOutput)
                rmSync(defaultOutput, { recursive: true })
                expect(await measured('defaultRestartRematerializeMs', () => build())).toBe(
                  defaultOutput,
                )
                expect(
                  readFileSync(join(defaultOutput, 'node_modules', 'dep', 'index.js'), 'utf8'),
                ).toBe('export default 1\n')
                expect(inventory(output)).toEqual(before)
              }),
          }
          const record = await measured('privatePublicationMs', () => publishEditorView(options))
          expect(reachedVerify).toBe(true)
          expect(inventory(output)).toEqual(before)
          expect(await verifyEditorViewSnapshot(options)).toEqual(record)
        } catch (cause) {
          publicationFailure = { cause }
          throw cause
        } finally {
          if (!privateRetired) {
            try {
              stopPrivate(owner)
            } catch (cause) {
              if (publicationFailure === undefined) throw cause
              throw new AggregateError(
                [publicationFailure.cause, cause],
                'Private publication and daemon retirement failed',
                { cause: publicationFailure.cause },
              )
            }
          }
        }
      },
    })
    timings.totalMs = performance.now() - started
    console.info(`[editor-publication-qualification] ${JSON.stringify(timings)}`)
  } catch (cause) {
    failure = { cause }
    throw cause
  } finally {
    try {
      if (!defaultRetired) await run(['kill'])
      // A failed mandatory stop keeps the owned fixture available for diagnosis.
      if (privateRetired && defaultRetired) {
        unlockDirectories(root)
        rmSync(root, { recursive: true })
        unlockDirectories(home)
        rmSync(home, { recursive: true })
      }
    } catch (cause) {
      if (failure === undefined) throw cause
      throw new AggregateError([failure.cause, cause], 'Publication test and cleanup failed', {
        cause: failure.cause,
      })
    } finally {
      if (savedBudget === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
      else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedBudget
    }
  }
}, 600_000)
