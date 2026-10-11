import assert from 'node:assert/strict'
import { lstat, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// No receipt is written until every positive control and negative probe passes.
const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  assert(index >= 0 && value !== undefined, `missing ${name}`)
  return value
}
const input = resolve(argument('--input'))
const closurePath = resolve(argument('--closure'))
const output = resolve(argument('--output'))
const scratch = process.env.BUCK_SCRATCH_PATH
assert.equal(process.platform, 'linux', 'containment probes require Linux; Darwin is unsupported')
assert(scratch !== undefined, 'executor scratch must be explicitly supplied')

const denied = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
  let failure: unknown
  try {
    await operation()
  } catch (cause) {
    failure = cause
  }
  assert(failure !== undefined, `${name}: forbidden operation succeeded`)
  assert(failure instanceof Error && 'code' in failure, `${name}: not a filesystem denial`)
  assert(
    ['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(String(failure.code)),
    `${name}: ${failure}`,
  )
}
const denyWrite = (name: string, path: string) =>
  denied(name, async () => {
    // Opening without truncation tests write permission without corrupting a host
    // input if the boundary regresses. Missing paths still attempt file creation.
    const file = await open(path, 'a')
    await file.close()
  })

assert((await readFile(input, 'utf8')).includes('No receipt is written'))
const closure: unknown = JSON.parse(await readFile(closurePath, 'utf8'))
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
assert(
  strings(closure) &&
    closure.length > 0 &&
    closure.every((path) => /^\/nix\/store\/[^/]+$/.test(path)),
)
const storeRoots = [...new Set(closure.map((path) => path.slice('/nix/store/'.length)))].sort()
assert.deepEqual(
  (await readdir('/nix/store')).sort(),
  storeRoots,
  'only the declared Bun Nix closure may be visible',
)
await lstat(process.execPath)
await denied('ambient shell', () => lstat('/bin/sh'))
await denied('ambient env executable', () => lstat('/usr/bin/env'))

const repositoryRoots = new Set([process.cwd(), resolve(dirname(input), '../../..')])
for (const root of repositoryRoots) {
  await denied('undeclared README.md', () => readFile(join(root, 'README.md')))
  await denied('undeclared .git', () => lstat(join(root, '.git')))
}
assert.equal(process.env.HOME, undefined, 'host HOME must not be inherited')
await denied('host passwd', () => readFile('/etc/passwd'))
await denied('root home', () => lstat('/root'))
// Ancestor directories can exist to reach declared artifacts, but their host
// contents must not. Probe the actual home ancestor as well as standard homes.
const homes = new Set(['/home/root', '/home/nobody', '/Users/Shared'])
for (const path of [process.cwd(), input, scratch]) {
  const match = /^\/(?:home|Users)\/[^/]+/.exec(path)
  if (match !== null) homes.add(match[0])
}
for (const home of homes) {
  for (const privatePath of ['.ssh', '.bashrc', '.config']) {
    await denied('host home contents', () => lstat(join(home, privatePath)))
  }
  await denyWrite('host home write', join(home, 'ts-sandbox-forbidden-write'))
}

await denyWrite('declared source write', input)
await denyWrite('declared closure manifest write', closurePath)
await denyWrite('declared Bun executable write', process.execPath)
await denyWrite('repository write', join(process.cwd(), 'ts-sandbox-forbidden-write'))
await denyWrite('root write', '/ts-sandbox-forbidden-write')
await denyWrite('host etc write', '/etc/ts-sandbox-forbidden-write')
// The declared output directory is writable in place; its host parent is not
// mounted. Siblings outside that directory remain invisible and read-only.
const hostSibling = join(dirname(dirname(output)), 'host-output-sibling')
await denied('host output sibling hidden', () => readFile(hostSibling))
await denyWrite('host output sibling write', hostSibling)
await denyWrite(
  'outside output directory',
  join(dirname(dirname(output)), 'ts-sandbox-forbidden-write'),
)
const outputSibling = join(dirname(output), 'writable-output-sibling')
await writeFile(outputSibling, 'declared output directory')
await rm(outputSibling)
for (const directory of [scratch, '/tmp']) {
  const path = join(directory, 'ts-sandbox-positive-write')
  await writeFile(path, 'private scratch')
  assert.equal(await readFile(path, 'utf8'), 'private scratch')
  await rm(path)
}

assert.deepEqual(Object.keys(process.env).sort(), [
  'BUCK_SCRATCH_PATH',
  'LC_ALL',
  'PWD',
  'TMPDIR',
  'TZ',
])
assert.equal(process.env.LC_ALL, 'C')
assert.equal(process.env.TZ, 'UTC')
assert.equal(process.env.TMPDIR, '/tmp')
assert.equal(
  process.env.PWD,
  process.cwd(),
  'PWD is the explicit action directory, not inherited host state',
)
assert.equal(process.env.TS_SANDBOX_INHERITED_SENTINEL, undefined)

const interfaces = Object.entries(networkInterfaces())
assert(
  interfaces.every(
    ([name, addresses]) => name === 'lo' && addresses?.every((address) => address.internal),
  ),
  'non-loopback network interface exposed',
)
const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n')
assert.equal(routes.length, 1, 'network namespace must have no IPv4 route')
const ipv6Routes = (await readFile('/proc/net/ipv6_route', 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
assert(
  ipv6Routes.every((route) => route.trim().split(/\s+/).at(-1) === 'lo'),
  'non-loopback IPv6 route exposed',
)
// A real TCP syscall, not a DNS failure or a missing client executable.
const {
  promise: socketDenied,
  resolve: socketFailed,
  reject: socketFailure,
} = Promise.withResolvers<void>()
const socket = connect({ host: '198.51.100.1', port: 9 })
socket.setTimeout(2_000)
socket.once('connect', () => {
  socket.destroy()
  socketFailure(new Error('external TCP socket connected outside the network namespace'))
})
socket.once('timeout', () => {
  socket.destroy()
  socketFailure(new Error('external TCP socket timed out instead of failing without a route'))
})
socket.once('error', (cause) => {
  socket.destroy()
  // Pinned Bun reports ECONNREFUSED even in the empty, routeless namespace;
  // the interface and route assertions above independently prove isolation.
  if (
    'code' in cause &&
    ['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(String(cause.code))
  )
    socketFailed()
  else socketFailure(cause)
})
await socketDenied

await writeFile(
  output,
  `${JSON.stringify({
    status: 'passed',
    boundary: 'linux-bwrap',
    writable: ['declared-output-directory', 'executor-scratch', 'private-tmp'],
    probes: {
      declaredInputReadable: true,
      declaredInputsReadOnly: true,
      exactBunClosure: true,
      undeclaredRepositoryHidden: true,
      hostHomesHidden: true,
      hostPasswdHidden: true,
      hostOutputSiblingsHidden: true,
      outsideWritesDenied: true,
      inheritedEnvironmentCleared: true,
      networkNamespaceIsolated: true,
      externalSocketDenied: true,
    },
  })}\n`,
)
