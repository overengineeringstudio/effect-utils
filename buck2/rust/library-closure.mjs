// Action glue: resolve only declared provider artifacts, never crawl buck-out.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [manifestPath, output, metadataPath, rustc, linker] = process.argv.slice(2)
const { primary, artifacts, targetTriple, hostTriple, panicStrategy } = JSON.parse(
  readFileSync(manifestPath, 'utf8'),
)
let crateName
const destinations = new Map()
for (const [artifact, simple, dynamic, role] of artifacts) {
  if (['link', 'full', 'proc-macro'].includes(role) === false)
    throw new Error(`Unsupported metadata role: ${role}`)
  const crate = dynamic !== null ? readFileSync(dynamic, 'utf8').trim() : simple
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(crate) === false) throw new Error(`Invalid crate: ${crate}`)
  let name = basename(artifact)
  if (artifact === primary) {
    name = `lib${crate}.rlib`
    crateName = crate
  } else if (dynamic !== null) {
    // Same provisional-name replacement as Prelude, retaining the hash/extension.
    const suffix = name.slice(name.lastIndexOf('-') + 1)
    if (name.includes('-') === false) throw new Error(`Missing Prelude suffix: ${artifact}`)
    name = `lib${crate}-${suffix}`
  }
  if (role === 'link' && name.endsWith('.rlib') === false)
    throw new Error(`Not an rlib: ${artifact}`)
  if (role === 'full' && /\.(rlib|rmeta)$/.test(name) === false)
    throw new Error(`Not full metadata: ${artifact}`)
  if (role === 'proc-macro' && /\.(so|dylib|dll)$/.test(name) === false)
    throw new Error(`Not a host macro: ${artifact}`)
  const previous = destinations.get(name)
  if (previous !== undefined && resolve(previous) !== resolve(artifact)) {
    throw new Error(`Flat destination collision ${name}: ${previous} != ${artifact}`)
  }
  destinations.set(name, artifact)
}
mkdirSync(output, { recursive: true })
for (const [name, artifact] of [...destinations].toSorted(([a], [b]) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)),
)) {
  copyFileSync(artifact, join(output, name))
}
const compiler = JSON.parse(
  execFileSync(rustc, ['--effect-utils-compiler-identity'], { encoding: 'utf8' }),
)
if (compiler.verboseVersion.match(/^host: (.+)$/m)?.[1] !== hostTriple) {
  throw new Error(`Compiler host differs from configured host: ${hostTriple}`)
}
const wrapper = compiler.darwinWrapperEvidence
if (
  typeof wrapper !== 'string' ||
  (wrapper !== '' &&
    (hostTriple.endsWith('-apple-darwin') === false ||
      /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/rustc$/.test(wrapper) === false))
) {
  throw new Error('Invalid compiler Darwin wrapper evidence')
}
if (crateName === undefined || ['unwind', 'abort'].includes(panicStrategy) === false)
  throw new Error('Missing primary or invalid panic strategy')
// Check the produced closure, not flags or environment that producers can override.
// Bypass Nix flag injection while preserving Darwin SDK/link/signing setup.
const scratch = resolve(process.env.BUCK_SCRATCH_PATH)
mkdirSync(scratch, { recursive: true })
const source = join(scratch, 'panic-probe.rs')
// Explicit aliases force rustc to load even declared-but-unused dependencies,
// including host macros and multiple hashes of the same crate name.
const probeCrates = [...destinations.keys()]
  .filter((name) => /\.(rlib|so|dylib|dll)$/.test(name))
  .toSorted()
  .map((name, index) => ({ alias: `closure_crate_${index}`, path: join(output, name) }))
writeFileSync(
  source,
  probeCrates.map(({ alias }) => `extern crate ${alias};\n`).join('') + 'fn main() {}\n',
)
execFileSync(
  wrapper || join(compiler.compilerStorePath, 'bin/rustc'),
  [
    ...(wrapper ? ['--effect-utils-link-probe'] : []),
    '--edition=2024',
    '--crate-name=library_panic_probe',
    source,
    ...probeCrates.flatMap(({ alias, path }) => ['--extern', `${alias}=${path}`]),
    '-L',
    `dependency=${output}`,
    `-Cpanic=${panicStrategy}`,
    '--sysroot',
    compiler.sysroot,
    '--target',
    targetTriple,
    `-Clinker=${linker}`,
    '-o',
    join(scratch, 'panic-probe'),
  ],
  { stdio: 'inherit' },
)
writeFileSync(
  metadataPath,
  JSON.stringify({ crateName, targetTriple, hostTriple, panicStrategy, rustc: compiler }) + '\n',
)
