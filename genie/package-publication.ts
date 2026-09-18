import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

export type Buck2PackagePin = {
  readonly integrity: string
  readonly url: string
}

const fail = (message: string): never => {
  throw new Error(`Buck package pin: ${message}`)
}

const record = ({
  value,
  location,
}: {
  readonly value: unknown
  readonly location: string
}): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) === true) {
    return fail(`${location} must be an object`)
  }
  return value as Record<string, unknown>
}

const string = ({
  value,
  location,
}: {
  readonly value: unknown
  readonly location: string
}): string => (typeof value === 'string' ? value : fail(`${location} must be a string`))

const canonicalJson = ({
  value,
  location,
}: {
  readonly value: unknown
  readonly location: string
}): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value) === true) return JSON.stringify(value)
  if (Array.isArray(value) === true) {
    return `[${value.map((entry, index) => canonicalJson({ value: entry, location: `${location}[${index}]` })).join(',')}]`
  }
  const object = record({ value, location })
  return `{${Object.keys(object)
    .toSorted()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson({ value: object[key], location: `${location}.${key}` })}`,
    )
    .join(',')}}`
}

const sameReleaseBinding = ({
  actual,
  expected,
}: {
  readonly actual: unknown
  readonly expected: {
    readonly name: string
    readonly tag: string
    readonly url: string
  }
}): boolean => {
  const release = record({ value: actual, location: 'release' })
  return (
    release['name'] === expected.name &&
    release['tag'] === expected.tag &&
    release['url'] === expected.url
  )
}

/**
 * Derive one immutable package pin from a consumer lock and the producer manifest fetched at that
 * locked commit. The caller owns fetching `nix/buck2-products/manifest.json`; this function keeps
 * every identity and digest check deterministic and free of I/O.
 */
export const deriveBuck2PackagePin = ({
  lock,
  manifest,
  packageName,
}: {
  readonly lock: unknown
  readonly manifest: unknown
  readonly packageName: string
}): Buck2PackagePin => {
  const lockObject = record({ value: lock, location: 'megarepo.lock' })
  const lockMembers = record({
    value: lockObject['members'],
    location: 'megarepo.lock.members',
  })
  const lockedMember = record({
    value: lockMembers['effect-utils'],
    location: 'megarepo.lock.members.effect-utils',
  })
  const producerCommit = string({
    value: lockedMember['commit'],
    location: 'megarepo.lock.members.effect-utils.commit',
  })
  if (/^[0-9a-f]{40}$/.test(producerCommit) === false) {
    return fail('effect-utils producer commit must be full lowercase Git hex')
  }

  const manifestObject = record({ value: manifest, location: 'manifest' })
  if (manifestObject['schema'] !== 'effect-utils/buck2-release-products/v1') {
    return fail('manifest has an unsupported schema')
  }
  const products = manifestObject['products']
  if (Array.isArray(products) === false) return fail('manifest.products must be an array')
  const matchingEntries = products.filter((value) => {
    const entry = record({ value, location: 'manifest.products[]' })
    const descriptor = record({
      value: entry['descriptor'],
      location: 'manifest.products[].descriptor',
    })
    return descriptor['productName'] === packageName
  })
  if (matchingEntries.length !== 1) {
    return fail(`manifest must contain exactly one ${packageName} product`)
  }

  const entry = record({ value: matchingEntries[0], location: `${packageName} entry` })
  if (entry['producerCommit'] !== producerCommit) {
    return fail(`${packageName} producer commit does not match megarepo.lock`)
  }
  const descriptor = record({
    value: entry['descriptor'],
    location: `${packageName} descriptor`,
  })
  if (descriptor['schema'] !== 'effect-utils/npm-package-product/v2') {
    return fail(`${packageName} descriptor has an unsupported schema`)
  }

  const transportSlug = string({
    value: descriptor['transportSlug'],
    location: `${packageName} transportSlug`,
  })
  const sha256 = string({ value: descriptor['sha256'], location: `${packageName} sha256` })
  const sha512 = string({ value: descriptor['sha512'], location: `${packageName} sha512` })
  const descriptorSha256 = string({
    value: entry['descriptorSha256'],
    location: `${packageName} descriptorSha256`,
  })
  if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(transportSlug) === false) {
    return fail(`${packageName} transport slug is unsafe`)
  }
  if (/^[0-9a-f]{64}$/.test(sha256) === false) return fail(`${packageName} sha256 is invalid`)
  if (/^sha512-[A-Za-z0-9+/]{86}==$/.test(sha512) === false) {
    return fail(`${packageName} sha512 integrity is invalid`)
  }

  const actualDescriptorSha256 = createHash('sha256')
    .update(canonicalJson({ value: descriptor, location: `${packageName} descriptor` }))
    .digest('hex')
  if (actualDescriptorSha256 !== descriptorSha256) {
    return fail(`${packageName} descriptor SHA-256 does not match`)
  }
  const payloadIntegrity = `sha256-${Buffer.from(sha256, 'hex').toString('base64')}`
  if (descriptor['integrity'] !== payloadIntegrity) {
    return fail(`${packageName} payload SHA-256 binding does not match`)
  }

  const tag = `buck2-package-v1-${transportSlug}-${sha256}`
  const name = `${sha256}-${transportSlug}.tgz`
  const url = `https://github.com/overengineeringstudio/effect-utils/releases/download/${tag}/${name}`
  const expectedRelease = { name, tag, url }
  if (sameReleaseBinding({ actual: descriptor['release'], expected: expectedRelease }) === false) {
    return fail(`${packageName} descriptor release binding does not match`)
  }
  if (sameReleaseBinding({ actual: entry['release'], expected: expectedRelease }) === false) {
    return fail(`${packageName} tracked release binding does not match`)
  }
  const release = record({ value: entry['release'], location: `${packageName} release` })
  if (release['hash'] !== payloadIntegrity) {
    return fail(`${packageName} release SHA-256 binding does not match`)
  }

  return { integrity: sha512, url }
}
