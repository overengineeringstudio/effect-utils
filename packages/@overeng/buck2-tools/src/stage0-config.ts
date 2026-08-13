/* oxlint-disable overeng/jsdoc-require-exports -- Exported contracts are documented by their precise field names and the stage-0 ABI constant. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const stage0ConfigResolverAbi = 'effect-utils.buck2-stage0-config.v1' as const

export const stage0Tools = [
  {
    configKey: 'closure_tool',
    flakeAttribute: 'buck2-closure-tool',
    executable: 'bin/buck2-closure-tool',
  },
  {
    configKey: 'package_evidence_tool',
    flakeAttribute: 'buck2-package-evidence',
    executable: 'bin/buck2-package-evidence',
  },
  {
    configKey: 'portable_toolchain',
    flakeAttribute: 'buck2-portable-toolchain',
    executable: 'bin/buck2-portable-toolchain',
  },
  {
    configKey: 'portable_toolchain_fixture',
    flakeAttribute: 'buck2-portable-toolchain-fixture',
    executable: 'bin/buck2-portable-toolchain-fixture',
  },
] as const

export interface SemanticInputDigest {
  readonly path: string
  readonly sha256: string
}

export interface Stage0ConfigRequest {
  readonly repoRoot: string
  readonly cacheRoot: string
  readonly nixBinary: string
  readonly flockBinary: string
  readonly bunBinary: string
  readonly resolverScript: string
  readonly semanticInputs: ReadonlyArray<string>
  readonly platform?: string
  readonly architecture?: string
}

export interface Stage0ConfigResult {
  readonly configPath: string
  readonly fingerprint: string
  readonly status: 'hit' | 'miss'
}

export type Stage0ConfigWorkerResult = Stage0ConfigResult | { readonly status: 'retry' }

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

export const fingerprintSemanticManifest = ({
  inputs,
  platform,
  architecture,
}: {
  readonly inputs: ReadonlyArray<SemanticInputDigest>
  readonly platform: string
  readonly architecture: string
}): string =>
  sha256(
    JSON.stringify({
      abi: stage0ConfigResolverAbi,
      architecture,
      inputs: inputs.toSorted((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
      platform,
      tools: stage0Tools,
    }),
  )

const relativeSemanticPath = ({ repoRoot, input }: { repoRoot: string; input: string }): string => {
  const path = relative(repoRoot, input)
  if (
    path === '' ||
    path === '..' ||
    path.startsWith(`..${sep}`) === true ||
    isAbsolute(path) === true
  ) {
    throw new Error(`semantic input must be a file below the repository root: ${input}`)
  }
  return path.split(sep).join('/')
}

export const digestSemanticInputs = async ({
  repoRoot,
  semanticInputs,
}: {
  readonly repoRoot: string
  readonly semanticInputs: ReadonlyArray<string>
}): Promise<ReadonlyArray<SemanticInputDigest>> => {
  if (semanticInputs.length === 0) throw new Error('at least one --semantic-input is required')
  const canonicalRoot = await realpath(repoRoot)
  const normalized = await Promise.all(
    semanticInputs.map(async (input) => {
      const canonicalInput = await realpath(resolve(canonicalRoot, input))
      const path = relativeSemanticPath({ repoRoot: canonicalRoot, input: canonicalInput })
      if ((await stat(canonicalInput)).isFile() === false) {
        throw new Error(`semantic input must be a regular file: ${input}`)
      }
      return path
    }),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('semantic inputs must be unique after path normalization')
  }
  return Promise.all(
    normalized.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolve(repoRoot, path))),
    })),
  )
}

const executableExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const expectedConfigKeys: ReadonlySet<string> = new Set(
  stage0Tools.map(({ configKey }) => configKey),
)

export const parseStage0Config = (contents: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {}
  let inStage0Section = false
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') === true) continue
    if (line.startsWith('[') === true && line.endsWith(']') === true) {
      if (line !== '[buck2_stage0]') throw new Error(`unexpected stage-0 config section: ${line}`)
      if (inStage0Section === true) throw new Error('duplicate stage-0 config section')
      inStage0Section = true
      continue
    }
    if (inStage0Section === false) throw new Error(`unexpected stage-0 config line: ${line}`)
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`invalid stage-0 config assignment: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (expectedConfigKeys.has(key) === false) {
      throw new Error(`unexpected stage-0 config key: ${key}`)
    }
    if (values[key] !== undefined) throw new Error(`duplicate stage-0 config key: ${key}`)
    if (isAbsolute(value) === false)
      throw new Error(`stage-0 executable must be absolute: ${value}`)
    values[key] = value
  }
  for (const key of expectedConfigKeys) {
    if (values[key] === undefined) throw new Error(`missing stage-0 config key: ${key}`)
  }
  if (inStage0Section === false) throw new Error('missing [buck2_stage0] config section')
  return values
}

const configMetadata = (
  contents: string,
): { readonly abi: string; readonly fingerprint: string } | undefined => {
  const abi = contents.match(/^# Resolver ABI: (.+)$/mu)?.[1]
  const fingerprint = contents.match(/^# Semantic fingerprint: ([0-9a-f]{64})$/mu)?.[1]
  return abi === undefined || fingerprint === undefined ? undefined : { abi, fingerprint }
}

export const validateStage0Config = async ({
  path,
  expectedFingerprint,
}: {
  readonly path: string
  readonly expectedFingerprint: string
}): Promise<boolean> => {
  try {
    const contents = await readFile(path, 'utf8')
    const metadata = configMetadata(contents)
    if (metadata?.abi !== stage0ConfigResolverAbi || metadata.fingerprint !== expectedFingerprint) {
      return false
    }
    const values = parseStage0Config(contents)
    const roots = resolve(dirname(path), 'roots')
    return (
      await Promise.all(
        stage0Tools.map(async ({ configKey, executable }) => {
          const value = values[configKey]!
          if ((await executableExists(value)) === false) return false
          try {
            return (
              (await realpath(value)) === (await realpath(resolve(roots, configKey, executable)))
            )
          } catch {
            return false
          }
        }),
      )
    ).every(Boolean)
  } catch {
    return false
  }
}

const run = async ({
  binary,
  args,
  cwd,
}: {
  readonly binary: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(stdout)
      else
        reject(
          new Error(
            `${binary} exited with ${code ?? signal ?? 'unknown status'}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
          ),
        )
    })
  })

const requestArgs = ({
  request,
  expectedFingerprint,
}: {
  request: Stage0ConfigRequest
  expectedFingerprint: string
}): ReadonlyArray<string> => [
  '--repo-root',
  request.repoRoot,
  '--cache-root',
  request.cacheRoot,
  '--nix-bin',
  request.nixBinary,
  '--flock-bin',
  request.flockBinary,
  '--bun-bin',
  request.bunBinary,
  '--resolver-script',
  request.resolverScript,
  '--platform',
  request.platform ?? process.platform,
  '--architecture',
  request.architecture ?? process.arch,
  '--expected-fingerprint',
  expectedFingerprint,
  ...request.semanticInputs.flatMap((input) => ['--semantic-input', input]),
]

const resolveIdentity = async (
  request: Stage0ConfigRequest,
): Promise<{ readonly fingerprint: string; readonly configPath: string }> => {
  const inputs = await digestSemanticInputs(request)
  const fingerprint = fingerprintSemanticManifest({
    inputs,
    platform: request.platform ?? process.platform,
    architecture: request.architecture ?? process.arch,
  })
  return {
    fingerprint,
    configPath: resolve(request.cacheRoot, fingerprint, 'buck2-stage0.conf'),
  }
}

/* oxlint-disable eslint/no-await-in-loop -- Each bounded retry must observe the identity after the previous locked realization; parallel attempts would race the same cache entry. */
export const resolveStage0Config = async (
  request: Stage0ConfigRequest,
): Promise<Stage0ConfigResult> => {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const identity = await resolveIdentity(request)
    if (
      (await validateStage0Config({
        path: identity.configPath,
        expectedFingerprint: identity.fingerprint,
      })) === true
    ) {
      return { ...identity, status: 'hit' }
    }

    await mkdir(resolve(request.cacheRoot, identity.fingerprint), { recursive: true })
    const lockPath = resolve(request.cacheRoot, `${identity.fingerprint}.lock`)
    const stdout = await run({
      binary: request.flockBinary,
      args: [
        '--exclusive',
        lockPath,
        request.bunBinary,
        request.resolverScript,
        '--internal-worker',
        ...requestArgs({ request, expectedFingerprint: identity.fingerprint }),
      ],
      cwd: request.repoRoot,
    })
    const result: unknown = JSON.parse(stdout)
    if (
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      result.status === 'retry'
    ) {
      continue
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      !('configPath' in result) ||
      typeof result.configPath !== 'string' ||
      !('fingerprint' in result) ||
      typeof result.fingerprint !== 'string' ||
      !('status' in result) ||
      (result.status !== 'hit' && result.status !== 'miss')
    ) {
      throw new Error('stage-0 worker returned an invalid result')
    }
    const validated: Stage0ConfigResult = {
      configPath: result.configPath,
      fingerprint: result.fingerprint,
      status: result.status,
    }
    if (
      validated.configPath !== identity.configPath ||
      validated.fingerprint !== identity.fingerprint ||
      (await validateStage0Config({
        path: validated.configPath,
        expectedFingerprint: identity.fingerprint,
      })) === false
    ) {
      throw new Error('stage-0 worker result does not match the requested identity')
    }
    return validated
  }
  throw new Error(`stage-0 semantic inputs remained unstable after ${maxAttempts} attempts`)
}
/* oxlint-enable eslint/no-await-in-loop */

const writeFileAtomic = async ({
  path,
  contents,
}: {
  path: string
  contents: string
}): Promise<void> => {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await chmod(temporary, 0o444)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const realizeTool = async ({
  request,
  configKey,
  fingerprint,
  flakeAttribute,
  executable,
}: {
  readonly request: Stage0ConfigRequest
  readonly configKey: string
  readonly fingerprint: string
  readonly flakeAttribute: string
  readonly executable: string
}): Promise<string> => {
  const rootPath = resolve(request.cacheRoot, fingerprint, 'roots', configKey)
  await mkdir(dirname(rootPath), { recursive: true })
  const stdout = await run({
    binary: request.nixBinary,
    args: [
      'build',
      '--out-link',
      rootPath,
      '--print-out-paths',
      `path:${request.repoRoot}#${flakeAttribute}`,
    ],
    cwd: request.repoRoot,
  })
  const outputPaths = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (outputPaths.length !== 1 || isAbsolute(outputPaths[0]!) === false) {
    throw new Error(`Nix returned an invalid output for ${flakeAttribute}`)
  }
  const executablePath = resolve(outputPaths[0]!, executable)
  if ((await executableExists(executablePath)) === false) {
    throw new Error(`Nix output ${flakeAttribute} is missing executable ${executable}`)
  }
  return executablePath
}

export const resolveStage0ConfigUnderLock = async ({
  request,
  expectedFingerprint,
}: {
  request: Stage0ConfigRequest
  expectedFingerprint?: string
}): Promise<Stage0ConfigWorkerResult> => {
  const identity = await resolveIdentity(request)
  if (expectedFingerprint !== undefined && identity.fingerprint !== expectedFingerprint) {
    return { status: 'retry' }
  }
  if (
    (await validateStage0Config({
      path: identity.configPath,
      expectedFingerprint: identity.fingerprint,
    })) === true
  )
    return { ...identity, status: 'hit' }

  const realized = await Promise.all(
    stage0Tools.map(async (tool) => ({
      configKey: tool.configKey,
      path: await realizeTool({ request, fingerprint: identity.fingerprint, ...tool }),
    })),
  )
  const settledIdentity = await resolveIdentity(request)
  if (settledIdentity.fingerprint !== identity.fingerprint) return { status: 'retry' }
  const inputs = await digestSemanticInputs(request)
  const contents = [
    '# Generated by @overeng/buck2-tools stage-0 config resolver. DO NOT EDIT.',
    `# Resolver ABI: ${stage0ConfigResolverAbi}`,
    `# Semantic fingerprint: ${identity.fingerprint}`,
    `# Semantic inputs: ${inputs
      .map(({ path }) => path)
      .toSorted()
      .join(', ')}`,
    '[buck2_stage0]',
    ...realized.map(({ configKey, path }) => `  ${configKey} = ${path}`),
    '',
  ].join('\n')
  await mkdir(resolve(request.cacheRoot, identity.fingerprint), { recursive: true })
  await writeFileAtomic({ path: identity.configPath, contents })
  if (
    (await validateStage0Config({
      path: identity.configPath,
      expectedFingerprint: identity.fingerprint,
    })) === false
  ) {
    throw new Error('generated stage-0 config failed validation')
  }
  return { ...identity, status: 'miss' }
}
