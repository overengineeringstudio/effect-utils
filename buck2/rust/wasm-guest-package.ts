import { readFile, writeFile } from 'node:fs/promises'

const options: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith('--')) {
    throw new Error('Expected --key value action arguments')
  }
  options[key.slice(2)] = value
}
const required = (key: string): string => {
  const value = options[key]
  if (value === undefined) throw new Error(`Missing action argument: ${key}`)
  return value
}

const moduleBytes = await readFile(required('input'))
if (
  moduleBytes.length < 8 ||
  moduleBytes[0] !== 0 ||
  moduleBytes[1] !== 0x61 ||
  moduleBytes[2] !== 0x73 ||
  moduleBytes[3] !== 0x6d
) {
  throw new Error('wasm guest is not a wasm module')
}
const version = moduleBytes.readUInt32LE(4)
if (version !== 1) throw new Error(`unsupported wasm version: ${version}`)

const guestModule = new WebAssembly.Module(moduleBytes)
const imports = WebAssembly.Module.imports(guestModule)
  .map(({ module, name }) => `${module}.${name}`)
  .sort()
const exports = WebAssembly.Module.exports(guestModule).sort((left, right) =>
  Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
)

const entrypoint = required('entrypoint')
let archiveName = entrypoint
let archivePrefix = ''
if (Buffer.byteLength(archiveName, 'utf8') > 100) {
  let separator = entrypoint.lastIndexOf('/')
  while (separator > 0) {
    const prefix = entrypoint.slice(0, separator)
    const name = entrypoint.slice(separator + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      archivePrefix = prefix
      archiveName = name
      break
    }
    separator = entrypoint.lastIndexOf('/', separator - 1)
  }
  if (archivePrefix === '') {
    throw new Error(
      `wasm guest entrypoint cannot be represented in USTAR (name limit 100 bytes, prefix limit 155 bytes): ${entrypoint}`,
    )
  }
}
const header = Buffer.alloc(512, 0)
header.write(archiveName, 0, 100, 'utf8')
header.write(archivePrefix, 345, 155, 'utf8')
header.write('0000755\0', 100, 'ascii')
header.write('0000000\0', 108, 'ascii')
header.write('0000000\0', 116, 'ascii')
header.write('00000000000\0', 136, 'ascii')
const size = moduleBytes.length.toString(8).padStart(11, '0')
header.write(`${size}\0`, 124, 'ascii')
header.write('0', 156, 'ascii')
header.write('ustar\0', 257, 'ascii')
header.write('00', 263, 'ascii')
header.fill(0x20, 148, 156)
let checksum = 0
for (const byte of header) checksum += byte
header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii')
header[154] = 0
header[155] = 0x20
const padding = Buffer.alloc((512 - (moduleBytes.length % 512)) % 512, 0)
const payload = Buffer.concat([header, moduleBytes, padding, Buffer.alloc(1024, 0)])

const provenance = JSON.parse(await readFile(required('provenance'), 'utf8')) as {
  recipe: string
  toolchain: string
}
const digest = Buffer.from(await crypto.subtle.digest('SHA-256', payload)).toString('base64')
const descriptor = {
  entrypoints: [entrypoint],
  name: required('name'),
  payload: {
    digest: { algorithm: 'sha256', sri: `sha256-${digest}` },
    file: 'artifact.tar',
    format: 'tar',
    sizeBytes: payload.length,
  },
  platform: { abi: 'unknown', architecture: 'wasm32', os: 'wasm' },
  runtime: {
    exports,
    harness: required('harness'),
    imports,
    inspectionContract: 'wasm32-unknown-unknown/v1',
    kind: 'wasm-guest',
    targetTriple: 'wasm32-unknown-unknown',
  },
  schema: 'buck-build-product/v1',
  semanticProvenance: {
    recipe: provenance.recipe,
    target: required('target'),
    toolchain: provenance.toolchain,
  },
}
await writeFile(required('payload'), payload)
await writeFile(required('descriptor'), `${JSON.stringify(descriptor)}\n`)
