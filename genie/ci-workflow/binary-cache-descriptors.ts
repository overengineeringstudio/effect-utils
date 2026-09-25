import { readFileSync } from 'node:fs'

/** Credential-free producer contract. Effect Schema validation runs at composition time. */
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

/** The bootstrap-safe export reads producer JSON without loading runtime-only Effect. */
export const effectUtilsBinaryCaches: Readonly<Record<string, BinaryCacheDescriptor>> = JSON.parse(
  readFileSync(new URL('../../nix/binary-caches.json', import.meta.url), 'utf8'),
)
