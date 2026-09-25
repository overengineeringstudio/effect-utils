import { readFileSync } from 'node:fs'

import {
  type BinaryCacheDescriptor,
  decodeBinaryCacheDescriptors,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/binary-cache-descriptor.ts'

export {
  type BinaryCacheDescriptor,
  BinaryCacheDescriptorError,
  type NixBinaryCacheDescriptor,
} from '../../packages/@overeng/genie/src/runtime/github-workflow/binary-cache-descriptor.ts'

/** Read and validate producer JSON; bootstrap-safe (no runtime packages) for consumer generators. */
export const readBinaryCacheDescriptors = (
  path: URL,
): Readonly<Record<string, BinaryCacheDescriptor>> =>
  decodeBinaryCacheDescriptors(JSON.parse(readFileSync(path, 'utf8')))

export const effectUtilsBinaryCaches = readBinaryCacheDescriptors(
  new URL('../../nix/binary-caches.json', import.meta.url),
)
