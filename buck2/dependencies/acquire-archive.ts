import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const fail = (message: string): never => {
  throw new Error(`pnpm archive acquisition: ${message}`)
}

/** Acquire from a configured CAS, recovering a missing object from the reviewed registry URL. */
export const acquireArchive = async ({
  casUrl,
  fetchArchive = fetch,
  output,
  registryUrl,
  sha256,
  size,
}: {
  readonly casUrl: string
  readonly fetchArchive?: typeof fetch
  readonly output: string
  readonly registryUrl: string
  readonly sha256: string
  readonly size: number
}): Promise<'cas' | 'registry'> => {
  if (/^[a-f0-9]{64}$/.test(sha256) === false) fail(`invalid sha256: ${sha256}`)
  if (Number.isSafeInteger(size) === false || size <= 0) fail(`invalid size: ${size}`)
  if (/^https?:\/\//.test(casUrl) === false) fail(`invalid CAS URL: ${casUrl}`)
  if (registryUrl.startsWith('https://') === false)
    fail(`canonical archive URL must use HTTPS: ${registryUrl}`)

  const cas = await fetchArchive(casUrl)
  const source = cas.status === 404 ? 'registry' : 'cas'
  const response = source === 'registry' ? await fetchArchive(registryUrl) : cas
  if (response.ok === false) fail(`${source} returned HTTP ${response.status}`)
  if (response.body === null) fail(`${source} returned no archive body`)

  const candidate = `${output}.candidate-${randomUUID()}`
  const hash = createHash('sha256')
  let received = 0
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > size) {
        callback(new Error(`pnpm archive acquisition: archive size exceeded ${size} bytes`))
        return
      }
      hash.update(chunk)
      callback(undefined, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(candidate))
    const actual = hash.digest('hex')
    if (actual !== sha256) fail(`archive digest mismatch: expected ${sha256}, got ${actual}`)
    if (received !== size) fail(`archive size mismatch: expected ${size}, got ${received}`)
    await rename(candidate, output)
  } catch (error) {
    await unlink(candidate).catch(() => undefined)
    throw error
  }
  return source
}

if (import.meta.main) {
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]
    const value = process.argv[index + 1]
    if (flag === undefined || value === undefined || flag.startsWith('--') === false)
      fail('expected --flag value arguments')
    args.set(flag, value)
  }
  await acquireArchive({
    casUrl: args.get('--cas-url') ?? fail('--cas-url is required'),
    registryUrl: args.get('--registry-url') ?? fail('--registry-url is required'),
    sha256: args.get('--sha256') ?? fail('--sha256 is required'),
    size: Number(args.get('--size') ?? fail('--size is required')),
    output: args.get('--output') ?? fail('--output is required'),
  })
}
