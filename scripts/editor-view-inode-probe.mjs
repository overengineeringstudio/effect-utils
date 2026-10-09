// Temporary #1743 branch-only filesystem probe; never merge into main.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
const output = resolve(process.env.RUNNER_TEMP ?? 'tmp', 'editor-view-hash-experiment')
mkdirSync(output, { recursive: true })
const command = (binary, args, options = {}) => {
  try {
    const stdout = execFileSync(binary, args, { encoding: 'utf8', ...options })
    const result = { binary, args, code: 0, stdout }
    console.log(JSON.stringify(result))
    return result
  } catch (error) {
    const result = { binary, args, code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error) }
    console.log(JSON.stringify(result))
    return result
  }
}
const mounts = [command('findmnt', ['-T', workspace, '-J']), command('stat', ['-f', workspace]), command('findmnt', ['-t', 'overlay', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'])]
writeFileSync(join(output, 'mountinfo.txt'), readFileSync('/proc/self/mountinfo'))
writeFileSync(join(output, 'mounts.json'), JSON.stringify(mounts, null, 2))
mkdirSync(join(workspace, 'tmp'), { recursive: true })
const bases = [{ label: 'workspace', parent: join(workspace, 'tmp') }]
if (existsSync('/dev/shm')) bases.push({ label: 'tmpfs-control', parent: '/dev/shm' })
const probes = bases.map(({ label, parent }) => {
  const root = mkdtempSync(join(parent, 'editor-inode-probe-'))
  const directories = [root]
  for (let index = 0; index < 256; index++) {
    const directory = join(root, `tree-${index}`, 'node_modules', 'nested')
    mkdirSync(directory, { recursive: true })
    directories.push(join(root, `tree-${index}`), join(root, `tree-${index}`, 'node_modules'), directory)
    writeFileSync(join(directory, 'bytes.txt'), `unchanged bytes ${index}\n`)
  }
  return { label, root, directories }
})
const inventory = ({ directories }) => directories.map(path => {
  const metadata = lstatSync(path, { bigint: true })
  return { path, dev: String(metadata.dev), ino: String(metadata.ino), mtimeNs: String(metadata.mtimeNs), ctimeNs: String(metadata.ctimeNs), size: String(metadata.size), mode: String(metadata.mode), nlink: String(metadata.nlink) }
})
const digest = ({ root }) => {
  const hash = createHash('sha256')
  for (let index = 0; index < 256; index++) hash.update(readFileSync(join(root, `tree-${index}`, 'node_modules', 'nested', 'bytes.txt')))
  return hash.digest('hex')
}
const rounds = []
try {
  for (let round = 1; round <= 3; round++) {
    const before = probes.map(probe => ({ label: probe.label, inventory: inventory(probe), digest: digest(probe) }))
    command('sync', [])
    const eviction = command('sudo', ['tee', '/proc/sys/vm/drop_caches'], { input: '2\n' })
    const after = probes.map(probe => ({ label: probe.label, inventory: inventory(probe), digest: digest(probe) }))
    const changes = before.map((probe, index) => ({
      label: probe.label,
      digestUnchanged: probe.digest === after[index].digest,
      inodeChanges: probe.inventory.flatMap((entry, position) => entry.ino === after[index].inventory[position].ino ? [] : [{ before: entry, after: after[index].inventory[position], changed: Object.keys(entry).filter(key => entry[key] !== after[index].inventory[position][key]) }]),
      otherChanges: probe.inventory.flatMap((entry, position) => Object.keys(entry).some(key => key !== 'ino' && entry[key] !== after[index].inventory[position][key]) ? [{ before: entry, after: after[index].inventory[position] }] : []),
    }))
    rounds.push({ round, eviction, before, after, changes })
    console.log(JSON.stringify({ round, evictionSucceeded: eviction.code === 0, changes: changes.map(change => ({ label: change.label, digestUnchanged: change.digestUnchanged, inodeChanges: change.inodeChanges.length, otherChanges: change.otherChanges.length, example: change.inodeChanges[0] })) }))
    writeFileSync(join(output, 'inode-probe.json'), JSON.stringify({ mounts, rounds }, null, 2))
    if (eviction.code !== 0) break
  }
} finally {
  for (const probe of probes) rmSync(probe.root, { recursive: true })
}
