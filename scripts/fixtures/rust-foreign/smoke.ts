// Regenerates both fixture Reindeer graphs, then (unless --generate-only) builds the provider
// library and runs the consumer against the genie-generated BUCK shards (`genie:run`).
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureRoot = 'scripts/fixtures/rust-foreign'
const generateOnly = process.argv.slice(2)
if (generateOnly.some((argument) => argument !== '--generate-only') || generateOnly.length > 1) {
  throw new Error('Usage: bun scripts/fixtures/rust-foreign/smoke.ts [--generate-only]')
}

const run = (command: readonly string[], capture = false): string => {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
    env: { ...process.env, RUSTC: rustc ?? undefined },
  })
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} exited ${result.exitCode}`)
  return capture ? result.stdout.toString().trim() : ''
}
const cargo = process.env.CARGO_BIN ?? Bun.which('cargo')
const rustc = process.env.RUSTC_BIN ?? Bun.which('rustc')
const reindeer = process.env.REINDEER_BIN ?? Bun.which('reindeer')
if (cargo === null || rustc === null || reindeer === null) {
  throw new Error(
    'Pinned cargo, rustc and reindeer must be on PATH or set CARGO_BIN/RUSTC_BIN/REINDEER_BIN',
  )
}

// The fixture has two independent authoritative locks and registry graphs.
for (const workspace of ['a', 'b']) {
  const workspaceRoot = `${fixtureRoot}/${workspace}`
  run(
    [cargo, 'metadata', '--format-version', '1', '--manifest-path', `${workspaceRoot}/Cargo.toml`],
    true,
  )
  run([
    `${root}scripts/buck2-rust-deps.sh`,
    'generate',
    root,
    workspaceRoot,
    `${workspaceRoot}/third-party/BUCK`,
    reindeer,
    cargo,
    rustc,
    process.execPath,
    `${root}scripts/buck2-rust-supply-manifest.ts`,
  ])
}

if (generateOnly.length === 0) {
  const buck2 = process.env.BUCK2_BIN ?? Bun.which('buck2')
  if (buck2 === null) throw new Error('Pinned buck2 must be on PATH or set BUCK2_BIN')
  run([
    buck2,
    'build',
    '--local-only',
    '--no-remote-cache',
    '-j',
    '2',
    `//${fixtureRoot}/b/crates/shared:lib`,
  ])
  const output = run(
    [
      buck2,
      'run',
      '--local-only',
      '--no-remote-cache',
      '-j',
      '2',
      `//${fixtureRoot}/a/app:foreign-consumer`,
    ],
    true,
  )
  if (output !== '42')
    throw new Error(`Foreign consumer returned ${JSON.stringify(output)}, expected "42"`)
  console.log('Foreign public third-party type fixture passed: 42')
}
