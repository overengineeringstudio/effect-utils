import { realpathSync } from 'node:fs'
import path from 'node:path'

// Reindeer cannot omit a foreign Source::Local target without also pruning its
// dependencies. Supply is instead projected from Cargo's complete resolved graph
// into a temporary workspace; the original Cargo.lock remains the authority.
const [root, workspace, cargo, cargoHome, supplyDir] = process.argv.slice(2)
if (
  root === undefined ||
  workspace === undefined ||
  cargo === undefined ||
  cargoHome === undefined ||
  supplyDir === undefined
) {
  throw new Error('expected root, workspace, cargo, cargo-home, supply directory')
}

type Package = {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly source: string | null
  readonly manifest_path: string
}
type Metadata = {
  readonly packages: readonly Package[]
  readonly workspace_members: readonly string[]
  readonly resolve: {
    readonly nodes: readonly {
      readonly id: string
      readonly features: readonly string[]
      readonly deps: readonly { readonly name: string; readonly pkg: string }[]
    }[]
  }
}
const cargoMetadata = (manifest: string, locked: boolean): Metadata => {
  const result = Bun.spawnSync({
    cmd: [
      cargo,
      'metadata',
      '--format-version',
      '1',
      '--all-features',
      '--manifest-path',
      manifest,
      ...(locked ? ['--locked'] : []),
    ],
    cwd: workspace,
    env: { ...process.env, CARGO_HOME: cargoHome, RUSTC_WRAPPER: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`Cargo metadata failed: ${result.stderr.toString()}`)
  return JSON.parse(result.stdout.toString()) as Metadata
}

const declarationPath = path.join(workspace, 'foreign-packages.json')
const declaration: unknown = JSON.parse(await Bun.file(declarationPath).text())
if (
  typeof declaration !== 'object' ||
  declaration === null ||
  !('foreignPackageManifestPaths' in declaration) ||
  !Array.isArray(declaration.foreignPackageManifestPaths) ||
  declaration.foreignPackageManifestPaths.length === 0 ||
  !declaration.foreignPackageManifestPaths.every((value) => typeof value === 'string')
) {
  throw new Error(`${declarationPath}: expected nonempty foreignPackageManifestPaths: string[]`)
}
const metadata = cargoMetadata(path.join(workspace, 'Cargo.toml'), true)
const byId = new Map(metadata.packages.map((entry) => [entry.id, entry]))
const foreignPaths = declaration.foreignPackageManifestPaths as string[]
for (const manifestPath of foreignPaths) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/Cargo\.toml$/.test(manifestPath) ||
    manifestPath.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error(`foreign package manifest must be a normalized repository-relative path: ${manifestPath}`)
  }
  const resolved = realpathSync(path.join(root, manifestPath))
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`foreign package manifest escapes repository: ${manifestPath}`)
  }
  const packageInfo = metadata.packages.find((entry) => entry.manifest_path === resolved)
  if (packageInfo === undefined || packageInfo.source !== null || metadata.workspace_members.includes(packageInfo.id)) {
    throw new Error(`foreign package is absent from the external path dependency graph: ${manifestPath}`)
  }
}
if (new Set(foreignPaths).size !== foreignPaths.length) {
  throw new Error('duplicate foreign package declarations')
}

const selected = metadata.packages.filter((entry) => entry.source !== null)
const featuresById = new Map(metadata.resolve.nodes.map((node) => [node.id, node.features]))
const namesById = new Map<string, string>()
for (const member of metadata.workspace_members) {
  const node = metadata.resolve.nodes.find((entry) => entry.id === member)
  for (const dep of node?.deps ?? []) {
    const pkg = byId.get(dep.pkg)
    if (pkg?.source !== null && pkg !== undefined && !namesById.has(pkg.id)) {
      namesById.set(pkg.id, dep.name)
    }
  }
}
const usedNames = new Set<string>()
const entries = selected.toSorted((a, b) => a.id.localeCompare(b.id)).map((pkg) => {
  const preferred = namesById.get(pkg.id) ?? pkg.name
  let key = preferred
  if (usedNames.has(key)) key = `buck2-supply-${pkg.name}-${pkg.version.replaceAll('.', '-')}`
  if (usedNames.has(key)) throw new Error(`ambiguous Cargo package supply alias: ${pkg.id}`)
  usedNames.add(key)
  const attrs: string[] = []
  if (key !== pkg.name) attrs.push(`package = ${JSON.stringify(pkg.name)}`)
  if (pkg.source?.startsWith('registry+https://github.com/rust-lang/crates.io-index') === true) {
    attrs.push(`version = ${JSON.stringify(`=${pkg.version}`)}`)
  } else if (pkg.source?.startsWith('git+') === true) {
    const source = pkg.source.slice(4)
    const hash = source.lastIndexOf('#')
    if (hash < 0 || !/^[0-9a-f]{40}$/.test(source.slice(hash + 1))) {
      throw new Error(`un-pinned git dependency in Cargo metadata: ${pkg.id}`)
    }
    attrs.push(`git = ${JSON.stringify(source.slice(0, hash).split('?')[0])}`)
    attrs.push(`rev = ${JSON.stringify(source.slice(hash + 1))}`)
  } else {
    throw new Error(`unsupported Cargo source for ${pkg.id}: ${pkg.source}`)
  }
  attrs.push('default-features = false')
  attrs.push(`features = ${JSON.stringify((featuresById.get(pkg.id) ?? []).toSorted())}`)
  return `${JSON.stringify(key)} = { ${attrs.join(', ')} }`
})
const supplyManifest = path.join(supplyDir, 'Cargo.toml')
await Bun.write(
  supplyManifest,
  `[package]\nname = "buck2-foreign-supply"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\nresolver = "2"\n\n[dependencies]\n${entries.join('\n')}\n`,
)
await Bun.write(path.join(supplyDir, 'src/lib.rs'), '// Dependency-only Reindeer workspace.\n')
const supplied = cargoMetadata(supplyManifest, false)
const sourceKey = (pkg: { readonly name: string; readonly version: string; readonly source?: string | null }) => {
  const source = pkg.source
  if (source?.startsWith('git+') === true) {
    const hash = source.lastIndexOf('#')
    if (hash < 0) throw new Error(`un-pinned git dependency: ${pkg.name}@${pkg.version}`)
    return `${pkg.name}@${pkg.version} git+${source.slice(4, hash).split('?')[0]}#${source.slice(hash + 1)}`
  }
  return `${pkg.name}@${pkg.version} ${source}`
}
const originalSources = selected.map(sourceKey).toSorted()
const suppliedSources = supplied.packages.filter((pkg) => pkg.source !== null).map(sourceKey).toSorted()
if (JSON.stringify(originalSources) !== JSON.stringify(suppliedSources)) {
  throw new Error('derived Reindeer supply changed the authoritative resolved package set')
}
const suppliedFeatures = new Map(supplied.resolve.nodes.map((node) => [node.id, node.features]))
for (const pkg of selected) {
  const derived = supplied.packages.find((entry) => sourceKey(entry) === sourceKey(pkg))
  if (
    derived === undefined ||
    JSON.stringify((featuresById.get(pkg.id) ?? []).toSorted()) !==
      JSON.stringify((suppliedFeatures.get(derived.id) ?? []).toSorted())
  ) {
    throw new Error(`derived Reindeer supply changed selected features for ${pkg.id}`)
  }
}
const originalLock = Bun.TOML.parse(await Bun.file(path.join(workspace, 'Cargo.lock')).text()) as {
  package: { name: string; version: string; source?: string; checksum?: string }[]
}
const derivedLock = Bun.TOML.parse(await Bun.file(path.join(supplyDir, 'Cargo.lock')).text()) as typeof originalLock
for (const pkg of derivedLock.package.filter((entry) => entry.source !== undefined)) {
  const original = originalLock.package.find((entry) => sourceKey(entry) === sourceKey(pkg))
  if (original === undefined || original.checksum !== pkg.checksum) {
    throw new Error(`derived Reindeer supply changed authoritative Cargo.lock pin for ${pkg.name}@${pkg.version}`)
  }
}
