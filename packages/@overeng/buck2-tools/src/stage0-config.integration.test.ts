import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseStage0Config } from './stage0-config.ts'

const cliPath = fileURLToPath(new URL('./stage0-config-cli.ts', import.meta.url))
const flockBinary =
  process.env.FLOCK_BIN ??
  process.env.PATH?.split(delimiter)
    .map((directory) => join(directory, 'flock'))
    .find(existsSync) ??
  'flock'

const runCli = async ({
  root,
  cacheRoot,
  semanticInputTrees = [],
  mutateDuringRealization = false,
  mutateDuringEveryRealization = false,
  mutateAbaDuringRealization = false,
}: {
  readonly root: string
  readonly cacheRoot: string
  readonly semanticInputTrees?: ReadonlyArray<string>
  readonly mutateDuringRealization?: boolean
  readonly mutateDuringEveryRealization?: boolean
  readonly mutateAbaDuringRealization?: boolean
}): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--repo-root',
        root,
        '--cache-root',
        cacheRoot,
        '--nix-bin',
        join(root, 'fake-nix'),
        '--flock-bin',
        flockBinary,
        '--bun-bin',
        process.execPath,
        '--semantic-input',
        'semantic.txt',
        ...semanticInputTrees.flatMap((path) => ['--semantic-input-tree', path]),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          FAKE_NIX_CALLS: join(root, 'calls'),
          FAKE_NIX_ROOT: join(root, 'store'),
          ...(mutateDuringRealization === true ? { FAKE_NIX_MUTATE_SEMANTIC: '1' } : {}),
          ...(mutateDuringEveryRealization === true ? { FAKE_NIX_MUTATE_ALWAYS: '1' } : {}),
          ...(mutateAbaDuringRealization === true ? { FAKE_NIX_MUTATE_ABA: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
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
    child.once('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }))
  })

const invocationCount = async (root: string): Promise<number> => {
  try {
    return (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

describe('Buck stage-0 config resolver', { timeout: 20_000 }, () => {
  let root: string
  let cacheRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'buck2-stage0-config-'))
    cacheRoot = join(root, 'cache')
    await writeFile(join(root, 'semantic.txt'), 'version one\n')
    await writeFile(join(root, 'unrelated.txt'), 'unrelated one\n')
    await writeFile(
      join(root, 'fake-nix'),
      `#!/bin/sh
set -eu
if [ "\${1:-}" = store ] && [ "\${2:-}" = add-path ]; then
  shift 2
  if [ "\${1:-}" = --name ]; then shift 2; fi
  snapshot="\${FAKE_NIX_ROOT%/*}-snapshot"
  rm -rf "$snapshot"
  mkdir -p "$snapshot"
  cp "$1/semantic.txt" "$snapshot/semantic.txt"
  if [ -d "$1/semantic-tree" ]; then cp -R "$1/semantic-tree" "$snapshot/semantic-tree"; fi
  printf '%s\\n' "$snapshot"
  exit 0
fi
installable=""
out_link=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-link) out_link="$2"; shift 2 ;;
    *) installable="$1"; shift ;;
  esac
done
attribute="\${installable##*#}"
case "$attribute" in
  buck2-closure-tool) executable="buck2-closure-tool" ;;
  buck2-package-evidence) executable="buck2-package-evidence" ;;
  buck2-portable-toolchain) executable="buck2-portable-toolchain" ;;
  buck2-portable-toolchain-fixture) executable="buck2-portable-toolchain-fixture" ;;
  *) echo "unexpected attribute: $attribute" >&2; exit 64 ;;
esac
output="$FAKE_NIX_ROOT/$attribute"
mkdir -p "$output/bin"
sequence=0
if [ "\${FAKE_NIX_MUTATE_ABA:-}" = 1 ]; then
  while ! mkdir "$FAKE_NIX_ROOT/aba-lock" 2>/dev/null; do sleep 0.01; done
  sequence=1
  while [ -e "$FAKE_NIX_ROOT/aba-$sequence" ]; do sequence=$((sequence + 1)); done
  : > "$FAKE_NIX_ROOT/aba-$sequence"
fi
source_root="\${installable#path:}"
source_root="\${source_root%%#*}"
cat "$source_root/semantic.txt" > "$output/semantic-value"
printf '#!/bin/sh\\ncat "%s/semantic-value"\\n' "$output" > "$output/bin/$executable"
chmod +x "$output/bin/$executable"
mkdir -p "$(dirname "$out_link")"
ln -sfn "$output" "$out_link"
printf '%s\\n' "$attribute" >> "$FAKE_NIX_CALLS"
if [ "\${FAKE_NIX_MUTATE_SEMANTIC:-}" = 1 ] && mkdir "$FAKE_NIX_ROOT/mutation-once" 2>/dev/null; then
  printf 'version two\\n' > semantic.txt
fi
if [ "\${FAKE_NIX_MUTATE_ALWAYS:-}" = 1 ]; then
  date +%s%N > semantic.txt
fi
if [ "$sequence" -gt 0 ]; then
  case "$sequence" in
    1) printf 'version two\\n' > semantic.txt ;;
    2) printf 'version one\\n' > semantic.txt ;;
  esac
  rmdir "$FAKE_NIX_ROOT/aba-lock"
fi
sleep 0.05
printf '%s\\n' "$output"
`,
    )
    await chmod(join(root, 'fake-nix'), 0o755)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}-snapshot`, { recursive: true, force: true })
  })

  it('hits across unrelated mutations and misses across semantic mutations', async () => {
    const cold = await runCli({ root, cacheRoot })
    expect(cold).toMatchObject({ exitCode: 0, stderr: '' })
    expect(await invocationCount(root)).toBe(4)

    await writeFile(join(root, 'unrelated.txt'), 'unrelated two\n')
    const unrelated = await runCli({ root, cacheRoot })
    expect(unrelated).toMatchObject({ exitCode: 0, stdout: cold.stdout, stderr: '' })
    expect(await invocationCount(root)).toBe(4)

    await writeFile(join(root, 'semantic.txt'), 'version two\n')
    const semantic = await runCli({ root, cacheRoot })
    expect(semantic.exitCode).toBe(0)
    expect(semantic.stdout).not.toBe(cold.stdout)
    expect(await invocationCount(root)).toBe(8)
  })

  it('discovers additions and removals from the runtime semantic input census', async () => {
    await mkdir(join(root, 'semantic-tree'))
    await writeFile(join(root, 'semantic-tree', 'existing.rs'), 'pub const EXISTING: u8 = 1;\n')
    const cold = await runCli({ root, cacheRoot, semanticInputTrees: ['semantic-tree'] })
    expect(cold).toMatchObject({ exitCode: 0, stderr: '' })

    await writeFile(join(root, 'semantic-tree', 'added.rs'), 'pub const ADDED: u8 = 2;\n')
    const added = await runCli({ root, cacheRoot, semanticInputTrees: ['semantic-tree'] })
    expect(added).toMatchObject({ exitCode: 0, stderr: '' })
    expect(added.stdout).not.toBe(cold.stdout)

    await unlink(join(root, 'semantic-tree', 'added.rs'))
    const removed = await runCli({ root, cacheRoot, semanticInputTrees: ['semantic-tree'] })
    expect(removed).toMatchObject({ exitCode: 0, stdout: cold.stdout, stderr: '' })
  })

  it('binds every realized tool to one immutable source snapshot across an A-B-A mutation', async () => {
    const result = await runCli({ root, cacheRoot, mutateAbaDuringRealization: true })
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    const config = parseStage0Config(await readFile(result.stdout.trim(), 'utf8'))
    const observed = await Promise.all(
      Object.values(config).map(
        (executable) =>
          new Promise<string>((resolvePromise, reject) => {
            const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'inherit'] })
            let stdout = ''
            child.stdout.setEncoding('utf8')
            child.stdout.on('data', (chunk: string) => {
              stdout += chunk
            })
            child.once('error', reject)
            child.once('close', (code) =>
              code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`tool exited ${code}`)),
            )
          }),
      ),
    )
    expect(new Set(observed)).toEqual(new Set(['version one']))
  })

  it('treats a missing cached executable as a miss and atomically repairs the config', async () => {
    const cold = await runCli({ root, cacheRoot })
    expect(cold.exitCode).toBe(0)
    const configPath = cold.stdout.trim()
    const config = parseStage0Config(await readFile(configPath, 'utf8'))
    await unlink(config.closure_tool!)

    const repaired = await runCli({ root, cacheRoot })
    expect(repaired).toMatchObject({ exitCode: 0, stdout: cold.stdout, stderr: '' })
    expect(await invocationCount(root)).toBe(8)
    expect((await stat(config.closure_tool!)).mode & 0o111).not.toBe(0)
    expect((await stat(configPath)).mode & 0o222).toBe(0)
  })

  it('rejects cache entries whose metadata or GC-root binding does not match their identity', async () => {
    const cold = await runCli({ root, cacheRoot })
    expect(cold.exitCode).toBe(0)
    const configPath = cold.stdout.trim()
    const original = await readFile(configPath, 'utf8')

    await chmod(configPath, 0o600)
    await writeFile(
      configPath,
      original.replace(
        /^# Semantic fingerprint: .+$/mu,
        `# Semantic fingerprint: ${'0'.repeat(64)}`,
      ),
    )
    const fingerprintRepaired = await runCli({ root, cacheRoot })
    expect(fingerprintRepaired.exitCode).toBe(0)
    expect(await invocationCount(root)).toBe(8)

    await chmod(configPath, 0o600)
    await writeFile(configPath, original.replace(/^# Resolver ABI: .+$/mu, '# Resolver ABI: stale'))
    const abiRepaired = await runCli({ root, cacheRoot })
    expect(abiRepaired.exitCode).toBe(0)
    expect(await invocationCount(root)).toBe(12)

    await unlink(join(dirname(configPath), 'roots', 'closure_tool'))
    const rootRepaired = await runCli({ root, cacheRoot })
    expect(rootRepaired.exitCode).toBe(0)
    expect(await invocationCount(root)).toBe(16)
  })

  it('single-flights concurrent cold callers under flock', async () => {
    const concurrentCache = join(root, 'concurrent-cache')
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => runCli({ root, cacheRoot: concurrentCache })),
    )
    expect(results.every(({ exitCode, stderr }) => exitCode === 0 && stderr === '')).toBe(true)
    expect(new Set(results.map(({ stdout }) => stdout).filter(Boolean)).size).toBe(1)
    expect(await invocationCount(root)).toBe(4)
    const configPath = results[0]!.stdout.trim()
    expect(dirname(configPath)).toMatch(concurrentCache)
    expect(await readFile(configPath, 'utf8')).toContain('[buck2_stage0]')
  })

  it('retries after a semantic mutation during realization instead of publishing stale identity', async () => {
    const result = await runCli({ root, cacheRoot, mutateDuringRealization: true })
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(await readFile(join(root, 'semantic.txt'), 'utf8')).toBe('version two\n')
    expect(await invocationCount(root)).toBe(8)
    const configPath = result.stdout.trim()
    const entries = await readdir(cacheRoot)
    const lockFingerprints = entries
      .filter((entry) => entry.endsWith('.lock'))
      .map((entry) => entry.slice(0, -5))
    expect(lockFingerprints).toHaveLength(2)
    expect(lockFingerprints.some((fingerprint) => configPath.includes(fingerprint))).toBe(true)
  })

  it('fails after bounded retries when semantic inputs never settle', async () => {
    const result = await runCli({ root, cacheRoot, mutateDuringEveryRealization: true })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('semantic inputs remained unstable after 3 attempts')
    expect(await invocationCount(root)).toBe(12)
  })

  it('rejects a semantic input symlink which escapes the repository', async () => {
    const external = await mkdtemp(join(tmpdir(), 'buck2-stage0-external-'))
    try {
      await writeFile(join(external, 'private.txt'), 'must not become cache identity\n')
      await unlink(join(root, 'semantic.txt'))
      await symlink(join(external, 'private.txt'), join(root, 'semantic.txt'))
      const result = await runCli({ root, cacheRoot })
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('semantic input must be a file below the repository root')
      expect(await invocationCount(root)).toBe(0)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })
})
