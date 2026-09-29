import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import path from 'node:path'

// Reindeer does not allow Source::Local to be mapped with extern_crates. Its
// omit_targets fixup stops traversal before the foreign source-access check.
const [root, workspace, configPath, thirdParty, cargo, cargoHome, overlay, temporaryConfig] =
  process.argv.slice(2)
if (
  root === undefined ||
  workspace === undefined ||
  configPath === undefined ||
  thirdParty === undefined ||
  cargo === undefined ||
  cargoHome === undefined ||
  overlay === undefined ||
  temporaryConfig === undefined
) {
  throw new Error('expected root, workspace, config, third-party, cargo, cargo-home, overlay, config output')
}

const declarationPath = path.join(workspace, 'foreign-packages.json')
const declaration: unknown = JSON.parse(await Bun.file(declarationPath).text())
if (
  typeof declaration !== 'object' ||
  declaration === null ||
  !('foreignPackageManifestPaths' in declaration) ||
  !Array.isArray(declaration.foreignPackageManifestPaths) ||
  !declaration.foreignPackageManifestPaths.every((value) => typeof value === 'string') ||
  declaration.foreignPackageManifestPaths.length === 0
) {
  throw new Error(`${declarationPath}: expected nonempty foreignPackageManifestPaths: string[]`)
}
const foreignPaths = declaration.foreignPackageManifestPaths as string[]
const configText = await Bun.file(configPath).text()
const config = Bun.TOML.parse(configText) as { fixups_dir?: string }
if (config.fixups_dir !== undefined) {
  throw new Error(`${configPath}: foreign packages require the default fixups_dir`)
}

const metadataRun = Bun.spawnSync({
  cmd: [cargo, 'metadata', '--locked', '--format-version', '1', '--manifest-path', path.join(workspace, 'Cargo.toml')],
  cwd: workspace,
  env: { ...process.env, CARGO_HOME: cargoHome, RUSTC_WRAPPER: '' },
  stdout: 'pipe',
  stderr: 'pipe',
})
if (metadataRun.exitCode !== 0) {
  throw new Error(`Cargo metadata failed: ${metadataRun.stderr.toString()}`)
}
const metadata = JSON.parse(metadataRun.stdout.toString()) as {
  packages: { name: string; manifest_path: string; source: string | null; targets: { name: string }[] }[]
}
const foreignPackages = foreignPaths.map((manifestPath) => {
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
  if (packageInfo === undefined || packageInfo.source !== null) {
    throw new Error(`foreign package is absent from the Cargo graph: ${manifestPath}`)
  }
  if (packageInfo.targets.length === 0) {
    throw new Error(`foreign package has no targets to omit: ${manifestPath}`)
  }
  if (metadata.packages.some((entry) => entry !== packageInfo && entry.name === packageInfo.name)) {
    throw new Error(`foreign package name collides with another Cargo package: ${packageInfo.name}`)
  }
  return packageInfo
})
if (new Set(foreignPackages.map((entry) => entry.name)).size !== foreignPackages.length) {
  throw new Error('duplicate foreign package declarations')
}

const originalFixups = path.join(thirdParty, 'fixups')
if (existsSync(originalFixups)) {
  for (const entry of readdirSync(originalFixups)) {
    symlinkSync(path.join(originalFixups, entry), path.join(overlay, entry))
  }
}
for (const packageInfo of foreignPackages) {
  const fixupDir = path.join(overlay, packageInfo.name)
  if (existsSync(fixupDir)) {
    throw new Error(`foreign package already has a fixup: ${packageInfo.name}`)
  }
  mkdirSync(fixupDir)
  await Bun.write(
    path.join(fixupDir, 'fixups.toml'),
    `omit_targets = [${packageInfo.targets.map((target) => JSON.stringify(target.name)).join(', ')}]\n`,
  )
}
// Keep the config in the original workspace so all its relative paths retain
// their meanings. The overlay is temporary in both generate and check modes.
await Bun.write(temporaryConfig, `fixups_dir = ${JSON.stringify(overlay)}\n${configText}`)
