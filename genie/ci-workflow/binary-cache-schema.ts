import { readFileSync } from 'node:fs'

import { Schema } from 'effect'

import type { BinaryCacheDescriptor } from './binary-cache-descriptors.ts'

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

/** The tagged union is evaluated only by runtime-phase workflow generation. */
export const BinaryCacheDescriptorSchema = Schema.Union([
  NixBinaryCacheDescriptor,
  ReapiCacheDescriptor,
])
const Registry = Schema.Record(Schema.String, BinaryCacheDescriptorSchema)

export class BinaryCacheDescriptorError extends Error {
  readonly _tag = 'BinaryCacheDescriptorError'
  readonly cacheName: string
  constructor({ cacheName, reason }: { cacheName: string; reason: string }) {
    super(`Invalid build cache ${cacheName}: ${reason}`)
    this.name = 'BinaryCacheDescriptorError'
    this.cacheName = cacheName
  }
}

/** Decode producer JSON at the TypeScript composition boundary. */
export const readBinaryCacheDescriptors = (
  path: URL,
): Readonly<Record<string, BinaryCacheDescriptor>> => {
  const descriptors = Schema.decodeUnknownSync(Schema.fromJsonString(Registry), {
    onExcessProperty: 'error',
  })(readFileSync(path, 'utf8'))
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor.name !== name) {
      throw new BinaryCacheDescriptorError({
        cacheName: name,
        reason: 'registry key differs from descriptor name',
      })
    }
  }
  return descriptors
}
