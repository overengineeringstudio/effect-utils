/* oxlint-disable overeng/exports-first -- The CLI and focused integration tests share the strict decoder and process launcher. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Only this trusted launcher executes outside the Linux action boundary. */
export type TsSandboxManifest = {
  readonly bubblewrap: string
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  readonly tools: readonly string[]
}

const fail = (message: string): never => {
  throw new Error(`TS sandbox (linux-bwrap): ${message}; unsandboxed execution is forbidden`)
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) === true && value.every((entry) => typeof entry === 'string')

const decodeManifest = (value: unknown): TsSandboxManifest => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('bubblewrap' in value) ||
    typeof value.bubblewrap !== 'string' ||
    !('inputs' in value) ||
    strings(value.inputs) === false ||
    !('outputs' in value) ||
    strings(value.outputs) === false ||
    !('tools' in value) ||
    strings(value.tools) === false
  )
    return fail('invalid declared sandbox manifest')
  return {
    bubblewrap: value.bubblewrap,
    inputs: value.inputs,
    outputs: value.outputs,
    tools: value.tools,
  }
}

/** Run the exact declared command with no ambient filesystem, environment or network. */
export const runTsSandbox = async ({
  manifest,
  command,
  scratch,
  cwd = process.cwd(),
}: {
  readonly manifest: TsSandboxManifest
  readonly command: readonly string[]
  readonly scratch: string
  readonly cwd?: string
}): Promise<number> => {
  if (process.platform !== 'linux') return fail('Linux execution platform required')
  if (command.length === 0) return fail('missing action command')
  try {
    await access(manifest.bubblewrap, constants.X_OK)
  } catch (cause) {
    return fail(
      `declared Bubblewrap is missing or not executable (${manifest.bubblewrap}): ${String(cause)}`,
    )
  }
  const actionScratch = await realpath(scratch)
  const staging = await mkdtemp(join(actionScratch, 'ts-sandbox-'))
  // The output backing must not be reachable through the child's writable
  // scratch mount: otherwise it could redirect the trusted copy-back through
  // a host-only symlink after exiting the namespace.
  const childScratch = await mkdtemp(join(actionScratch, 'ts-scratch-'))
  try {
    const args = [
      '--unshare-all',
      '--unshare-user',
      '--die-with-parent',
      '--new-session',
      '--disable-userns',
      '--clearenv',
      '--proc',
      '/proc',
      '--remount-ro',
      '/proc',
      '--dev',
      '/dev',
      '--remount-ro',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      childScratch,
      actionScratch,
      '--dir',
      cwd,
    ]
    // Bind an empty backing directory, not the host output parent: sibling artifacts
    // and undeclared files in that parent must never become visible or writable.
    const outputParents = new Map<string, string>()
    for (const output of manifest.outputs) {
      const parent = dirname(resolve(cwd, output))
      if (outputParents.has(parent) === false) {
        const backing = join(staging, `output-${outputParents.size}`)
        await mkdir(backing)
        outputParents.set(parent, backing)
        args.push('--bind', backing, parent)
      }
    }
    const mounted = new Set<string>()
    for (const input of [...manifest.inputs, ...manifest.tools]) {
      const logical = resolve(cwd, input)
      const canonical = await realpath(logical)
      // Preserve both artifact spelling and symlink destinations. The only canonical
      // destinations exposed are those of declared inputs and exact tool closures.
      for (const destination of new Set([logical, canonical])) {
        if (mounted.has(destination) === false) {
          args.push('--ro-bind', canonical, destination)
          mounted.add(destination)
        }
      }
    }
    args.push(
      '--remount-ro',
      '/',
      '--chdir',
      cwd,
      '--setenv',
      'LC_ALL',
      'C',
      '--setenv',
      'TZ',
      'UTC',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'BUCK_SCRATCH_PATH',
      actionScratch,
      '--setenv',
      'PWD',
      cwd,
      '--',
      ...command,
    )
    const status = await new Promise<number>((done, reject) => {
      const child = spawn(manifest.bubblewrap, args, { cwd, env: {}, stdio: 'inherit' })
      child.once('error', reject)
      child.once('close', (code, signal) => done(code ?? (signal === null ? 1 : 128)))
    }).catch((cause) => fail(`Bubblewrap could not start: ${String(cause)}`))
    if (status !== 0) {
      console.error(
        `TS sandbox (linux-bwrap): action or Bubblewrap failed (exit ${status}); no unsandboxed fallback`,
      )
      return status
    }
    for (const output of manifest.outputs) {
      const destination = resolve(cwd, output)
      const backing = outputParents.get(dirname(destination))
      if (backing === undefined) return fail(`missing output backing for ${output}`)
      const source = join(backing, destination.slice(dirname(destination).length + 1))
      await mkdir(dirname(destination), { recursive: true })
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      })
    }
    return 0
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(childScratch, { recursive: true, force: true })
  }
}

if (import.meta.main === true) {
  try {
    const manifestPath = process.argv[2] ?? fail('missing sandbox manifest')
    const command = process.argv.slice(3)
    const scratch =
      process.env.BUCK_SCRATCH_PATH ?? fail('executor did not provide BUCK_SCRATCH_PATH')
    process.exitCode = await runTsSandbox({
      manifest: decodeManifest(JSON.parse(await readFile(manifestPath, 'utf8'))),
      command,
      scratch,
    })
  } catch (cause) {
    console.error(String(cause))
    process.exitCode = 1
  }
}
