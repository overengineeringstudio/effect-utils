import { readFileSync } from 'node:fs'

import { Schema } from 'effect'

const Name = Schema.String.check(Schema.isPattern(/^[^\s]+$/))
const Visibility = Schema.Literal('public', 'private')
const NixBinaryCacheDescriptor = Schema.Struct({
  kind: Schema.Literal('nix-binary'),
  name: Name,
  visibility: Visibility,
  uri: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/)),
  publicKey: Schema.String.check(Schema.isPattern(/^[^\s:]+:[^\s]+$/)),
})
const ReapiCacheDescriptor = Schema.Struct({
  kind: Schema.Literal('reapi'),
  name: Name,
  visibility: Visibility,
  endpoint: Schema.String.check(Schema.isPattern(/^grpcs?:\/\/[^\s]+$/)),
  instanceName: Name,
  digest: Schema.Literal('SHA256'),
})

/** Credential-free contract shared by producer JSON, genie, and the Nix reader. */
export const BinaryCacheDescriptor = Schema.Union([NixBinaryCacheDescriptor, ReapiCacheDescriptor])
export type BinaryCacheDescriptor = typeof BinaryCacheDescriptor.Type
export type NixBinaryCacheDescriptor = typeof NixBinaryCacheDescriptor.Type

const Registry = Schema.Record(Schema.String, BinaryCacheDescriptor)

/** Read a producer's JSON once at workflow generation, rejecting malformed or renamed entries. */
export const readBinaryCacheDescriptors = (path: URL): Readonly<Record<string, BinaryCacheDescriptor>> => {
  const descriptors = Schema.decodeUnknownSync(Schema.fromJsonString(Registry), { onExcessProperty: 'error' })(
    readFileSync(path, 'utf8'),
  )
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor.name !== name) {
      throw new BinaryCacheDescriptorError(name, 'registry key differs from descriptor name')
    }
  }
  return descriptors
}

export class BinaryCacheDescriptorError extends Error {
  readonly _tag = 'BinaryCacheDescriptorError'
  constructor(readonly cacheName: string, reason: string) {
    super(`Invalid build cache ${cacheName}: ${reason}`)
    this.name = 'BinaryCacheDescriptorError'
  }
}

export const effectUtilsBinaryCaches = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)
