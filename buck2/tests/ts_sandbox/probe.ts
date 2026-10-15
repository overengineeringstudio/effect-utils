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

const denied = async ({
  name,
  operation,
}: {
  name: string
  operation: () => Promise<unknown>
}): Promise<void> => {
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
const denyWrite = ({ name, path }: { name: string; path: string }) =>
  denied({
    name,
    operation: async () => {
      // Opening without truncation tests write permission without corrupting a host
      // input if the boundary regresses. Missing paths still attempt file creation.
      const file = await open(path, 'a')
      await file.close()
    },
  })

// Host-shared fingerprint coordination survives the private /tmp boundary,
// without granting payloads permission to replace the semaphore's inodes.
const fingerprintLocks = '/tmp/effect-utils-buck2-fingerprint-v1'
for (const slot of ['admission', 'slot-0', 'slot-1', 'slot-2', 'slot-3']) {
  const path = join(fingerprintLocks, slot)
  const status = await lstat(path)
  assert(status.isFile(), `missing host fingerprint lock: ${slot}`)
  await readFile(path)
  await denyWrite({ name: `fingerprint admission ${slot} is read-only`, path })
}

assert((await readFile(input, 'utf8')).includes('No receipt is written'))
const closure: unknown = JSON.parse(await readFile(closurePath, 'utf8'))
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
assert(
  strings(closure) &&
    closure.length > 0 &&
    closure.every((path) => /^\/nix\/store\/[^/]+$/.test(path)),
)
const storeRoots = [...new Set(closure.map((path) => path.slice('/nix/store/'.length)))].toSorted()
assert.deepEqual(
  (await readdir('/nix/store')).toSorted(),
  storeRoots,
  'only the declared Bun Nix closure may be visible',
)
await lstat(process.execPath)
await denied({ name: 'ambient shell', operation: () => lstat('/bin/sh') })
await denied({ name: 'ambient env executable', operation: () => lstat('/usr/bin/env') })

const repositoryRoots = new Set([process.cwd(), resolve(dirname(input), '../../..')])
await Promise.all(
  [...repositoryRoots].flatMap((root) => [
    denied({ name: 'undeclared README.md', operation: () => readFile(join(root, 'README.md')) }),
    denied({ name: 'undeclared .git', operation: () => lstat(join(root, '.git')) }),
  ]),
)
assert.equal(process.env.HOME, undefined, 'host HOME must not be inherited')
await denied({ name: 'host passwd', operation: () => readFile('/etc/passwd') })
await denied({ name: 'root home', operation: () => lstat('/root') })
// Ancestor directories can exist to reach declared artifacts, but their host
// contents must not. Probe the actual home ancestor as well as standard homes.
const homes = new Set(['/home/root', '/home/nobody', '/Users/Shared'])
for (const path of [process.cwd(), input, scratch]) {
  const match = /^\/(?:home|Users)\/[^/]+/.exec(path)
  if (match !== null) homes.add(match[0])
}
await Promise.all(
  [...homes].flatMap((home) =>
    ['.ssh', '.bashrc', '.config']
      .map((privatePath) =>
        denied({ name: 'host home contents', operation: () => lstat(join(home, privatePath)) }),
      )
      .concat(
        denyWrite({ name: 'host home write', path: join(home, 'ts-sandbox-forbidden-write') }),
      ),
  ),
)

await denyWrite({ name: 'declared source write', path: input })
await denyWrite({ name: 'declared closure manifest write', path: closurePath })
await denyWrite({ name: 'declared Bun executable write', path: process.execPath })
await denyWrite({
  name: 'repository write',
  path: join(process.cwd(), 'ts-sandbox-forbidden-write'),
})
await denyWrite({ name: 'root write', path: '/ts-sandbox-forbidden-write' })
await denyWrite({ name: 'host etc write', path: '/etc/ts-sandbox-forbidden-write' })
// The declared output directory is writable in place; its host parent is not
// mounted. Siblings outside that directory remain invisible and read-only.
const hostSibling = join(dirname(dirname(output)), 'host-output-sibling')
await denied({ name: 'host output sibling hidden', operation: () => readFile(hostSibling) })
await denyWrite({ name: 'host output sibling write', path: hostSibling })
await denyWrite({
  name: 'outside output directory',
  path: join(dirname(dirname(output)), 'ts-sandbox-forbidden-write'),
})
const outputSibling = join(dirname(output), 'writable-output-sibling')
await writeFile(outputSibling, 'declared output directory')
await rm(outputSibling)
await Promise.all(
  [scratch, '/tmp'].map(async (directory) => {
    const path = join(directory, 'ts-sandbox-positive-write')
    await writeFile(path, 'private scratch')
    assert.equal(await readFile(path, 'utf8'), 'private scratch')
    await rm(path)
  }),
)

assert.deepEqual(Object.keys(process.env).toSorted(), [
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

// Down fallback tunnels (tunl0, ip6tnl0) can exist in every new netns; only an
// addressed non-loopback interface or a non-loopback route grants egress.
const interfaces = Object.values(networkInterfaces())
assert(
  interfaces.every((addresses) => addresses?.every((address) => address.internal) === true),
  'non-loopback network address exposed',
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
    ['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(String(cause.code)) === true
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
