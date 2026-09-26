import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const fail = (message: string): never => {
  throw new Error(`Nix archive: ${message}`)
}

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index]
  const value = process.argv[index + 1]
  if (flag === undefined || value === undefined || flag.startsWith('--') === false)
    fail('expected --flag value arguments')
  args.set(flag, value)
}

const root = args.get('--root') ?? fail('--root is required')
const sha256 = args.get('--sha256') ?? fail('--sha256 is required')
// pnpm locks record the archive size; Cargo.lock does not, so crates pin the digest only.
const sizeText = args.get('--size')
const output = args.get('--output') ?? fail('--output is required')
if (isAbsolute(root) === false || root.startsWith('/nix/store/') === false)
  fail(`root must be an immutable Nix store path: ${root}`)
if (/^[a-f0-9]{64}$/.test(sha256) === false) fail(`invalid sha256: ${sha256}`)
const size = sizeText === undefined ? undefined : Number(sizeText)
if (size !== undefined && (Number.isSafeInteger(size) === false || size <= 0))
  fail(`invalid size: ${sizeText}`)

const source = join(root, `${sha256}.tgz`)
const hash = createHash('sha256')
let copiedBytes = 0
const hasher = new Transform({
  transform(chunk: Buffer, _encoding, callback) {
    copiedBytes += chunk.byteLength
    hash.update(chunk)
    callback(undefined, chunk)
  },
})
await pipeline(createReadStream(source), hasher, createWriteStream(output))
const actual = hash.digest('hex')
if (actual !== sha256) fail(`archive digest mismatch: expected ${sha256}, got ${actual}`)
if (size !== undefined && copiedBytes !== size) fail(`archive size mismatch: expected ${size}, got ${copiedBytes}`)
