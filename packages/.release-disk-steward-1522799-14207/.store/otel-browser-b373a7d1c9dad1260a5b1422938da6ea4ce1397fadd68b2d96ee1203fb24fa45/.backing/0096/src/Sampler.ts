/**
 * Head sampling for root spans. Children follow their parent (Effect already propagates
 * `sampled = false`), and a remote parent's `traceparent` flag wins over the local decision, so a
 * browser never exports half a trace. The decision also travels outward: an unsampled browser
 * trace sends `traceparent ...-00`, telling the gateway not to sample its half either.
 *
 * Sampling gates export only; the in-app span ring still sees every span.
 */

/** Root-span identity available to a head sampler. */
export interface SampleInput {
  readonly name: string
  readonly sessionId: string
}

/** Determines whether a local root span is exported. */
export type Sampler = (input: SampleInput) => boolean

/** Exports every root span. */
export const alwaysOn: Sampler = () => true
/** Keeps spans in the ring without exporting any root spans. */
export const alwaysOff: Sampler = () => false

/** FNV-1a over the session id, mapped to [0, 1): stable per session, uniform enough for ratios. */
const sessionFraction = (sessionId: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

/**
 * Samples `ratio` of root spans. `per: 'session'` (default) keeps or drops a whole tab session,
 * which keeps interaction → long-frame → vitals stories intact; `per: 'trace'` decides per root.
 */
export const ratio = ({
  value,
  per,
}: {
  readonly value: number
  readonly per?: 'session' | 'trace'
}): Sampler => {
  if (value >= 1) return alwaysOn
  if (value <= 0) return alwaysOff
  return per === 'trace'
    ? () => Math.random() < value
    : (input) => sessionFraction(input.sessionId) < value
}
