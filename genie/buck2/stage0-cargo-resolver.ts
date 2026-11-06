import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { CargoProjection } from './stage0-cargo.ts'

export const refreshCommand = 'bash nix/stage0-cargo/refresh.sh'
interface LockRecord { key: string; block: string }
const records = (lock: string) => lock.split(/(?=^\[\[package\]\]$)/m).slice(1).map((block) => {
  const key = block.split('\n').filter((line) => /^(name|version|source) = /.test(line)).join('\n')
  return { key, block: block.trimEnd() }
})
const withoutDependencies = (block: string) => block.replace(/^dependencies = \[[\s\S]*?^\]\n?/m, '').trim()
const dependencies = (block: string) => [...(block.match(/^dependencies = \[\n([\s\S]*?)^\]/m)?.[1] ?? '')
  .matchAll(/^ "([^"]+)",$/gm)].map((match) => match[1]!)
const dependencyKey = (dependency: string, available: LockRecord[]) => {
  const [, name, version, source] = /^(\S+)(?: (\S+))?(?: \((.*)\))?$/.exec(dependency) ?? []
  const matches = available.filter(({ key }) => key.includes(`name = "${name}"`) &&
    (version === undefined || key.includes(`version = "${version}"`)) &&
    (source === undefined || key.includes(`source = "${source}"`)))
  if (matches.length !== 1) throw new Error(`Invalid projected Cargo dependency: ${dependency}; ${refreshCommand}`)
  return matches[0]!.key
}
export const cargoAuthority = (projection: CargoProjection, rootLock: string, readMember: (member: string) => string) => {
  const original = records(rootLock), projected = records(projection.lock)
  const roots = new Map(original.map(({ key, block }) => [key, block]))
  const used = projected.map(({ key, block: candidate }) => {
    const block = roots.get(key)
    if (block === undefined || withoutDependencies(block) !== withoutDependencies(candidate) ||
      dependencies(candidate).some((dependency) => !dependencies(block).some((rootDependency) =>
        dependencyKey(dependency, projected) === dependencyKey(rootDependency, original)))) {
      throw new Error(`Stale stage-zero Cargo record; refresh: ${refreshCommand}`)
    }
    return block
  }).toSorted()
  return createHash('sha256').update(JSON.stringify([
    projection.manifest, projection.members.map(readMember), rootLock.split('[[package]]')[0], used, projection.lock,
  ])).digest('hex')
}
export const resolveCargoLock = (projection: CargoProjection) => {
  const cargo = process.env.STAGE0_CARGO
  const vendor = process.env.STAGE0_VENDOR
  if (!cargo || !vendor) throw new Error(`Refresh needs pinned Cargo and Nix vendor; run: ${refreshCommand}`)
  mkdirSync('tmp', { recursive: true })
  const root = mkdtempSync('tmp/stage0-refresh-')
  try {
    for (const member of projection.members) {
      mkdirSync(`${root}/${member}/..`, { recursive: true })
      cpSync(`rust/${member}`, `${root}/${member}`, { recursive: true })
    }
    mkdirSync(`${root}/.cargo`, { recursive: true })
    mkdirSync(`${root}/cargo-home`, { recursive: true })
    writeFileSync(`${root}/.cargo/config.toml`, `[source.crates-io]\nreplace-with = "nix-vendor"\n[source.nix-vendor]\ndirectory = ${JSON.stringify(vendor)}\n`)
    writeFileSync(`${root}/Cargo.toml`, projection.manifest)
    writeFileSync(`${root}/Cargo.lock`, projection.lock)
    const result = Bun.spawnSync([cargo, 'update', '--workspace', '--offline'], {
      cwd: root, env: { ...process.env, CARGO_HOME: `${process.cwd()}/${root}/cargo-home` },
    })
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    return readFileSync(`${root}/Cargo.lock`, 'utf8')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
