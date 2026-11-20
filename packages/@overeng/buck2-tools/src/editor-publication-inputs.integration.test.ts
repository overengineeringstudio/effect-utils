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

import { requireEditorPublicationInputs } from './editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  editorPublicationOwnerFdEnv,
  requireEditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'
import { publishEditorView, verifyEditorViewSnapshot } from './editor-view.ts'

// Run with the declared Bun/Vitest runner and BUCK2_BIN, CP_BIN, MV_BIN,
// FINGERPRINT_BIN. Ownership uses the real Bun FFI flock implementation.
// This suite deliberately fails when a required pinned tool is absent.
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
  const timings: Record<string, number> = {}
  const started = performance.now()
  const savedBudget = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  process.env.EDITOR_VIEW_HOST_BUDGET_STATE = join(root, 'host-budget.json')
  const run = async (args: string[], fd?: number): Promise<string> => {
    const env = { ...process.env }
    delete env[editorPublicationOwnerFdEnv]
    if (fd !== undefined) env[editorPublicationOwnerFdEnv] = '3'
    const child = spawn(buck, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe', ...(fd === undefined ? [] : [fd])],
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
    child.once('error', exited.reject)
    child.once('close', (code, signal) => {
      if (code === 0) exited.resolve()
      else exited.reject(new Error(`Buck ${args.join(' ')} failed (${code ?? signal}): ${stderr}`))
    })
    await exited.promise
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
  const build = async (fd?: number): Promise<string> => {
    const selection = fd === undefined ? [] : ['--isolation-dir', editorPublicationIsolation]
    const result: unknown = JSON.parse(
      await run([...selection, 'build', '--show-full-json-output', '//:inputs'], fd),
    )
    assert(result !== null && typeof result === 'object')
    const outputs = Object.values(result)
    assert(outputs.length === 1 && typeof outputs[0] === 'string')
    return outputs[0]
  }
  try {
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(
      join(root, '.buckconfig'),
      '[cells]\nfixture = .\n[buck2]\nfile_watcher = fs_hash_crawler\nremote_cache_enabled = false\n',
    )
    writeFileSync(
      join(root, 'inputs.bzl'),
      `def _impl(ctx):
    descriptor = ctx.actions.write("descriptor.json", '{"revision":1}\\n')
    payload = ctx.actions.write("index.js", 'export default 1\\n')
    tree = ctx.actions.copied_dir("publication", {
        "editor_inputs/install-descriptor.json": descriptor,
        "node_modules/dep/index.js": payload,
    })
    return [DefaultInfo(default_output = tree)]
inputs = rule(impl = _impl, attrs = {})
`,
    )
    writeFileSync(join(root, 'BUCK'), 'load(":inputs.bzl", "inputs")\ninputs(name = "inputs")\n')
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
    const defaultOutput = await measured('warmDefaultBuildMs', () => build())
    await withEditorPublicationOwner({
      root,
      run: async (fd) => {
        const output = await measured('coldPrivateBuildMs', () => build(fd))
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
          publicationOwnerFd: fd,
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
                  env: { [editorPublicationOwnerFdEnv]: String(fd) },
                }),
              ).toBe(fd)
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
        await run(['--isolation-dir', editorPublicationIsolation, 'kill'], fd)
      },
    })
    timings.totalMs = performance.now() - started
    console.info(`[editor-publication-qualification] ${JSON.stringify(timings)}`)
  } finally {
    try {
      await run(['kill'])
    } finally {
      try {
        await withEditorPublicationOwner({
          root,
          run: (fd) => run(['--isolation-dir', editorPublicationIsolation, 'kill'], fd),
        })
      } finally {
        if (savedBudget === undefined) delete process.env.EDITOR_VIEW_HOST_BUDGET_STATE
        else process.env.EDITOR_VIEW_HOST_BUDGET_STATE = savedBudget
        unlockDirectories(root)
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}, 600_000)
