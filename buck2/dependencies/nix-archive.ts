import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readFile } from 'node:fs/promises'

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
const sourceRepo = args.get('--source-repo')
const sourceRev = args.get('--source-rev')
// pnpm locks record the archive size; Cargo.lock does not, so crates pin the digest only.
const sizeText = args.get('--size')
const output = args.get('--output') ?? fail('--output is required')
if (isAbsolute(root) === false || root.startsWith('/nix/store/') === false)
  fail(`root must be an immutable Nix store path: ${root}`)
if (/^[a-f0-9]{64}$/.test(sha256) === false) fail(`invalid sha256: ${sha256}`)
const size = sizeText === undefined ? undefined : Number(sizeText)
if (size !== undefined && (Number.isSafeInteger(size) === false || size <= 0))
  fail(`invalid size: ${sizeText}`)
if ((sourceRepo === undefined) !== (sourceRev === undefined))
  fail('--source-repo and --source-rev must be specified together')
if (sourceRepo !== undefined && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(sourceRepo) === false)
  fail(`invalid source repo: ${sourceRepo}`)
if (sourceRev !== undefined && /^[a-f0-9]{40}$/.test(sourceRev) === false)
  fail(`invalid source rev: ${sourceRev}`)
let expected = sha256
const sourcePin = join(root, `${sha256}.source.sha256`)
if (sourceRepo !== undefined && existsSync(sourcePin)) {
  const [repo, rev, digest, ...extra] = (await readFile(sourcePin, 'utf8')).trimEnd().split('\n')
  if (repo !== sourceRepo || rev !== sourceRev || extra.length !== 0 || digest === undefined || /^[a-f0-9]{64}$/.test(digest) === false)
    fail(`source digest manifest mismatch for ${sourceRepo}@${sourceRev}`)
  expected = digest
}

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
if (actual !== expected) fail(`archive digest mismatch: expected ${expected}, got ${actual}`)
if (size !== undefined && copiedBytes !== size) fail(`archive size mismatch: expected ${size}, got ${copiedBytes}`)
