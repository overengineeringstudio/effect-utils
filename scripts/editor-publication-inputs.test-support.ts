import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
} from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import {
  runOwnedEditorPublicationCommand,
  stopOwnedEditorPublicationDaemon,
} from './buck2-entrypoint.ts'

// Required pinned tools and owner DSO are declared by the integration target.
// Every build uses the real managed native boundary; no descriptors cross it.
export const tool = (name: string): string => {
  const value = process.env[name]
  assert(value, `required integration tool: ${name}`)
  assert(realpathSync(value).startsWith('/nix/store/'), `${name} must be Nix-pinned`)
  return value
}
const unlockDirectories = (path: string): void => {
  const status = lstatSync(path)
  if (status.isDirectory() === false || status.isSymbolicLink() === true) return
  chmodSync(path, (status.mode & 0o777) | 0o700)
  for (const name of readdirSync(path)) unlockDirectories(join(path, name))
}

export type NativePublicationFixture = {
  root: string
  buck: string
  native: string
  git: string
  authority: string
  run: (args: readonly string[], owner?: EditorPublicationOwner) => Promise<string>
  build: (owner?: EditorPublicationOwner) => Promise<string>
  measured: <T>(name: string, action: () => Promise<T>) => Promise<T>
  stopPrivate: (owner: EditorPublicationOwner) => void
  privateIsRetired: () => boolean
}

export const withNativePublicationFixture = async (
  action: (fixture: NativePublicationFixture) => Promise<void>,
): Promise<void> => {
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const scratch = join(repository, 'tmp', 'editor-publication-inputs')
  mkdirSync(scratch, { recursive: true })
  const root = realpathSync(mkdtempSync(join(scratch, 'run-')))
  const buck = tool('BUCK2_BIN')
  const native = tool('BUCK2_NATIVE_BIN')
  const git = tool('GIT_BIN')
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
  const run = async (args: readonly string[], owner?: EditorPublicationOwner): Promise<string> => {
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
    // Buck cells are normalized project-relative paths, as in consumer-root.nix.
    cpSync(storeFixture, join(root, 'rules'), { recursive: true })
    writeFileSync(
      join(root, '.buckconfig'),
      '[cells]\nfixture = .\nrules = rules\n[buck2]\nfile_watcher = fs_hash_crawler\nremote_cache_enabled = false\n',
    )
    writeFileSync(
      join(root, 'BUCK'),
      'load("@rules//:inputs.bzl", "inputs")\ninputs(name = "inputs", src = "package.json")\ninputs(name = "package.json", src = "package.json")\n',
    )
    writeFileSync(join(root, 'package.json'), '{}\n')
    const authority = join(root, 'workspace-authority.json')
    writeFileSync(
      authority,
      JSON.stringify({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: ['.'],
        ownedPackages: ['.'],
      }),
    )
    execFileSync(git, ['init', '--quiet', root])
    execFileSync(git, ['-C', root, 'add', 'package.json'])
    await action({
      root, buck, native, git, authority, run, build, measured, stopPrivate,
      privateIsRetired: () => privateRetired,
    })
    timings.totalMs = performance.now() - started
    console.info(`[editor-publication-qualification] ${JSON.stringify(timings)}`)
  } catch (cause) {
    failure = { cause }
  }
  try {
    if (defaultRetired === false) await run(['kill'])
    // A failed mandatory stop keeps the owned fixture available for diagnosis.
    if (privateRetired === true && defaultRetired === true) {
      unlockDirectories(root)
      rmSync(root, { recursive: true })
      unlockDirectories(home)
      rmSync(home, { recursive: true })
    }
  } catch (cause) {
    failure = {
      cause:
        failure === undefined
          ? cause
          : new AggregateError([failure.cause, cause], 'Publication test and cleanup failed', {
              cause: failure.cause,
            }),
    }
  } finally {
    if (savedBudget === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
    else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedBudget
  }
  if (failure !== undefined) throw failure.cause
}
