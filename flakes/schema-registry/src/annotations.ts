import type { Annotations as EffectAnnotations } from 'effect/Schema'

/** Resolved Effect metadata with the shared registry vocabulary available to node hooks. */
export type RegistryAnnotations = EffectAnnotations.Annotations

/** One fleet annotation vocabulary shared by semantic authorities and renderers. */
export const Registry = {
  sensitivity: 'x-sensitivity',
  row: 'x-row',
  format: 'x-format',
  public: 'x-public',
} as const
/** Static minimum disclosure classification attached to each semantic schema node. */
export type Sensitivity = 'public' | 'internal' | 'restricted' | 'secret'
/** Portable human rendering operation for a composite fact or linked value. */
export type RenderFormat = 'space' | 'join' | 'link'
/** Frozen public-view normalization operation interpreted by authority lowering. */
export type PublicRule = 'short-session' | 'strip-host'

declare module 'effect/Schema' {
  namespace Annotations {
    // The namespace/interface names are fixed by Effect's augmentation API.
    // oxlint-disable-next-line eslint/no-shadow
    interface Annotations {
      readonly 'x-sensitivity'?: Sensitivity
      readonly 'x-row'?: boolean
      readonly 'x-format'?: RenderFormat
      readonly 'x-public'?: PublicRule
    }
  }
}
