import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Version pins read from the Weaver flake and generated registry source. */
export type WeaverVersionPins = {
  readonly semconv: string
  readonly weaver: string
}

const requiredMatch = ({
  input,
  pattern,
  name,
}: {
  input: string
  pattern: RegExp
  name: string
}) => {
  const value = pattern.exec(input)?.[1]
  if (value === undefined) throw new Error(`Could not parse ${name}`)
  return value
}

/** Parse the Weaver and semantic-conventions versions declared by both sources of truth. */
export const parseWeaverVersionPins = ({
  flakeNix,
  registrySource,
}: {
  readonly flakeNix: string
  readonly registrySource: string
}): { readonly flake: WeaverVersionPins; readonly registry: WeaverVersionPins } => ({
  flake: {
    weaver: requiredMatch({
      input: flakeNix,
      pattern: /\bversion = "([0-9]+\.[0-9]+\.[0-9]+)"/u,
      name: 'flake Weaver version',
    }),
    semconv: requiredMatch({
      input: flakeNix,
      pattern: /\bsemconvVersion = "([0-9]+\.[0-9]+\.[0-9]+)"/u,
      name: 'flake semconv version',
    }),
  },
  registry: {
    weaver: requiredMatch({
      input: registrySource,
      pattern: /\bPINNED_WEAVER_VERSION = '([^']+)'/u,
      name: 'registry Weaver version',
    }),
    semconv: requiredMatch({
      input: registrySource,
      pattern: /\bPINNED_UPSTREAM_SEMCONV_VERSION = '([^']+)'/u,
      name: 'registry semconv version',
    }),
  },
})

/** Extract the semantic-conventions version encoded in a resolved model store path. */
export const parseSemconvModelVersion = (modelPath: string): string =>
  requiredMatch({
    input: modelPath,
    pattern: /-semconv-model-([0-9]+\.[0-9]+\.[0-9]+)$/u,
    name: 'semantic conventions model version',
  })

const parseArgs = (args: readonly string[]) => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === undefined || value === undefined || flag.startsWith('--') === false)
      throw new Error(`Invalid argument sequence at ${flag ?? '<end>'}`)
    values.set(flag, value)
  }
  const required = (flag: string) => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`Missing ${flag}`)
    return value
  }
  return { required }
}

const run = ({
  executable,
  args,
}: {
  readonly executable: string
  readonly args: readonly string[]
}): string => {
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${executable} exited ${result.status ?? 'without a status'}`)
  }
  return result.stdout.trim()
}

const semconvModelPath = (locator: string): string => {
  const path = run({ executable: locator, args: [] })
  if (path.startsWith('/') === false || path.includes('\n') === true)
    throw new Error('semconv-model capability returned a non-absolute path')
  return path
}

const checkRegistry = async ({
  registry,
  weaver,
  semconvModel,
}: {
  registry: string
  weaver: string
  semconvModel: string
}) => {
  const scratch = await mkdtemp(join(tmpdir(), 'weaver-check-'))
  const scratchRegistry = join(scratch, 'registry')
  try {
    await cp(registry, scratchRegistry, { recursive: true })
    const manifest = join(scratchRegistry, 'manifest.yaml')
    await chmod(manifest, 0o600)
    const contents = await readFile(manifest, 'utf8')
    const rewritten = contents.replace(/^([ \t]*registry_path:[ \t]*).+$/mu, `$1${semconvModel}`)
    if (rewritten === contents) throw new Error('Registry manifest has no upstream registry_path')
    await writeFile(manifest, rewritten)
    run({ executable: weaver, args: ['registry', 'check', '-r', scratchRegistry, '--future'] })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const checkVersions = async ({
  flakeNix,
  registrySource,
  weaver,
  semconvModel,
}: {
  flakeNix: string
  registrySource: string
  weaver: string
  semconvModel: string
}) => {
  const pins = parseWeaverVersionPins({
    flakeNix: await readFile(flakeNix, 'utf8'),
    registrySource: await readFile(registrySource, 'utf8'),
  })
  if (pins.registry.weaver !== pins.flake.weaver)
    throw new Error(
      `Weaver pin drift: flake ${pins.flake.weaver}, registry ${pins.registry.weaver}`,
    )
  if (pins.registry.semconv !== `v${pins.flake.semconv}`)
    throw new Error(
      `semconv pin drift: flake v${pins.flake.semconv}, registry ${pins.registry.semconv}`,
    )
  const builtSemconvVersion = parseSemconvModelVersion(await realpath(semconvModel))
  if (builtSemconvVersion !== pins.flake.semconv)
    throw new Error(
      `Built semconv model version ${builtSemconvVersion} does not match ${pins.flake.semconv}`,
    )
  const builtVersion = requiredMatch({
    input: run({ executable: weaver, args: ['--version'] }),
    pattern: /\b([0-9]+\.[0-9]+\.[0-9]+)\b/u,
    name: 'built Weaver version',
  })
  if (builtVersion !== pins.flake.weaver)
    throw new Error(`Built Weaver version ${builtVersion} does not match ${pins.flake.weaver}`)
  return pins
}

const main = async () => {
  const { required } = parseArgs(Bun.argv.slice(2))
  const mode = required('--mode')
  const weaver = required('--weaver')
  const semconvModel = semconvModelPath(required('--semconv-model'))
  const output = required('--output')
  const evidence =
    mode === 'check'
      ? await checkRegistry({ registry: required('--registry'), weaver, semconvModel })
      : mode === 'version-smoke'
        ? await checkVersions({
            flakeNix: required('--flake-nix'),
            registrySource: required('--registry-source'),
            semconvModel,
            weaver,
          })
        : (() => {
            throw new Error(`Unknown mode: ${mode}`)
          })()
  await writeFile(
    output,
    `${JSON.stringify({ mode, semconvModel, evidence: evidence ?? 'validated' })}\n`,
  )
}

if (import.meta.main === true) await main()
