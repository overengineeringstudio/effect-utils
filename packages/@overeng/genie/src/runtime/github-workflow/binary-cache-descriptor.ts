/**
 * Credential-free build cache descriptor contract.
 *
 * Validation is hand-written and dependency-free so consumer generators can
 * read producer JSON during bootstrap, when member checkouts have no
 * node_modules and runtime packages such as `effect` are unavailable.
 */
export type BinaryCacheDescriptor = {
  readonly name: string
  readonly visibility: 'public' | 'private'
} & (
  | { readonly kind: 'nix-binary'; readonly uri: string; readonly publicKey: string }
  | {
      readonly kind: 'reapi'
      readonly endpoint: string
      readonly instanceName: string
      readonly digest: 'SHA256'
    }
)

export type NixBinaryCacheDescriptor = Extract<BinaryCacheDescriptor, { kind: 'nix-binary' }>

/** Producer descriptor that does not match the tagged cache contract. */
export class BinaryCacheDescriptorError extends Error {
  readonly _tag = 'BinaryCacheDescriptorError'
  readonly cacheName: string
  constructor({ cacheName, reason }: { cacheName: string; reason: string }) {
    super(`Invalid build cache ${cacheName}: ${reason}`)
    this.name = 'BinaryCacheDescriptorError'
    this.cacheName = cacheName
  }
}

const namePattern = /^[^\s]+$/
const fieldPatterns: Record<BinaryCacheDescriptor['kind'], Readonly<Record<string, RegExp>>> = {
  'nix-binary': {
    name: namePattern,
    visibility: /^(?:public|private)$/,
    uri: /^https:\/\/[^\s]+$/,
    publicKey: /^[^\s:]+:[^\s]+$/,
  },
  reapi: {
    name: namePattern,
    visibility: /^(?:public|private)$/,
    endpoint: /^grpcs?:\/\/[^\s]+$/,
    instanceName: namePattern,
    digest: /^SHA256$/,
  },
}

/** JSON object fields; arrays and null are rejected so descriptors cannot be positional. */
const objectFields = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

/** Decode one descriptor exactly: known kind, every field present and well-formed, no extras. */
export const decodeBinaryCacheDescriptor = (
  value: unknown,
  registryKey?: string,
): BinaryCacheDescriptor => {
  const fields = objectFields(value)
  const cacheName =
    registryKey ?? (typeof fields?.name === 'string' ? fields.name : '<unnamed descriptor>')
  const fail = (reason: string): never => {
    throw new BinaryCacheDescriptorError({ cacheName, reason })
  }
  if (fields === undefined) return fail('expected an object')
  const kind = fields.kind
  if (kind !== 'nix-binary' && kind !== 'reapi') {
    return fail(`kind must be "nix-binary" or "reapi", got ${JSON.stringify(kind)}`)
  }
  const patterns = fieldPatterns[kind]
  for (const key of Object.keys(fields)) {
    if (key !== 'kind' && patterns[key] === undefined) {
      fail(`unexpected field ${JSON.stringify(key)} for ${kind}`)
    }
  }
  for (const [key, pattern] of Object.entries(patterns)) {
    const field = fields[key]
    if (field === undefined) fail(`missing ${key}`)
    if (typeof field !== 'string' || pattern.test(field) === false) {
      fail(`invalid ${key} ${JSON.stringify(field)}`)
    }
  }
  return fields as BinaryCacheDescriptor
}

/** Decode a producer registry keyed by descriptor name. */
export const decodeBinaryCacheDescriptors = (
  value: unknown,
): Readonly<Record<string, BinaryCacheDescriptor>> => {
  const registry = objectFields(value)
  if (registry === undefined) {
    throw new BinaryCacheDescriptorError({
      cacheName: 'registry',
      reason: 'expected an object keyed by cache name',
    })
  }
  const descriptors: Record<string, BinaryCacheDescriptor> = {}
  for (const [name, entry] of Object.entries(registry)) {
    const descriptor = decodeBinaryCacheDescriptor(entry, name)
    if (descriptor.name !== name) {
      throw new BinaryCacheDescriptorError({
        cacheName: name,
        reason: 'registry key differs from descriptor name',
      })
    }
    descriptors[name] = descriptor
  }
  return descriptors
}
