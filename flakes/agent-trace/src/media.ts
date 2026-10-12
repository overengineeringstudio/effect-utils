import { Effect, Schema, SchemaIssue, SchemaTransformation } from 'effect'

import { PrivateAudienceV2, plan as privateAudiencePlan } from '../generated/PrivateAudienceV2.ts'
import { PrivateFooterV2, plan as privateFooterPlan } from '../generated/PrivateFooterV2.ts'
import { PrivateTrailerV2, plan as privateTrailerPlan } from '../generated/PrivateTrailerV2.ts'
import { PublicAudienceV2, plan as publicAudiencePlan } from '../generated/PublicAudienceV2.ts'
import { PublicFooterV2, plan as publicFooterPlan } from '../generated/PublicFooterV2.ts'
import { PublicTrailerV2, plan as publicTrailerPlan } from '../generated/PublicTrailerV2.ts'
import { assertCurrentWriter } from './current-writer.ts'
import { makeProjection } from './projection.ts'
import { renderFooterHuman, renderTrailerHuman } from './render.ts'
import { strict, type Audience } from './schema.ts'
/** Beginning marker of the owned Agent Trace footer region. */
export const footerBegin = '<!-- agent-trace:begin -->'
/** Ending marker of the owned Agent Trace footer region. */
export const footerEnd = '<!-- agent-trace:end -->'
const machineTrailer = 'Agent-Trace: agent-trace/v2 trailer/v2 '
const machineFooter = '<!-- agent-trace/v2 footer/v4 '
const makeCodec = <T extends Schema.Codec<unknown, unknown>>({
  view,
  audience,
  medium,
}: {
  view: T
  audience: Audience
  medium: 'footer' | 'trailer'
}) => {
  const jsonView = Schema.fromJsonString(view)
  const decodeMachine = Schema.decodeEffect(jsonView, strict)
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (wire) =>
          Effect.try({
            try: () => {
              if (medium === 'trailer') {
                const rows = wire.split('\n').filter((line) => line.startsWith('Agent-Trace:'))
                if (rows.length !== 1 || !rows[0]!.startsWith(machineTrailer))
                  throw new TypeError('Expected one versioned Agent-Trace trailer')
                return rows[0]!.slice(machineTrailer.length)
              }
              if (!wire.startsWith(footerBegin + '\n') || !wire.endsWith('\n' + footerEnd))
                throw new TypeError('Invalid footer region')
              const regions = [...wire.matchAll(/<!-- agent-trace\/v2 footer\/v4 (.*?) -->/g)]
              if (regions.length !== 1) throw new TypeError('Expected one footer machine region')
              return regions[0]![1]!
            },
            catch: (cause) => new SchemaIssue.Forbidden({ message: String(cause) }),
          }),
        encode: (machine) =>
          decodeMachine(machine).pipe(
            Effect.mapError((error) => error.issue),
            Effect.flatMap((value) =>
              Effect.try({
                try: () => {
                  if (medium === 'trailer')
                    return `${renderTrailerHuman(value)}\n${machineTrailer}${machine}`
                  return `${footerBegin}\n${renderFooterHuman({ view: value, audience: audience })}\n${machineFooter}${machine.replaceAll('--', '\\u002d\\u002d').replaceAll('>', '\\u003e')} -->\n${footerEnd}`
                },
                catch: (cause) => new SchemaIssue.Forbidden({ message: String(cause) }),
              }),
            ),
          ),
      }),
    ),
    Schema.decodeTo(jsonView),
  ).check(
    Schema.makeFilter((input) => {
      try {
        assertCurrentWriter(input)
        return undefined
      } catch (cause) {
        return String(cause)
      }
    }),
  )
}
/** Strict public trailer/v2 codec enforcing current-writer requirements. */
export const PublicTrailerCodecV2 = makeCodec({
  view: PublicTrailerV2,
  audience: 'public-minimal',
  medium: 'trailer',
})
/** Strict private trailer/v2 codec enforcing current-writer requirements. */
export const PrivateTrailerCodecV2 = makeCodec({
  view: PrivateTrailerV2,
  audience: 'private-rich',
  medium: 'trailer',
})
/** Strict public footer/v4 codec enforcing current-writer requirements. */
export const PublicFooterCodecV4 = makeCodec({
  view: PublicFooterV2,
  audience: 'public-minimal',
  medium: 'footer',
})
/** Strict private footer/v4 codec enforcing current-writer requirements. */
export const PrivateFooterCodecV4 = makeCodec({
  view: PrivateFooterV2,
  audience: 'private-rich',
  medium: 'footer',
})
/** Encodes only the branded public trailer view with frozen strict options. */
export const encodePublicTrailer = Schema.encodeSync(PublicTrailerCodecV2, strict)
/** Encodes only the branded private trailer view with frozen strict options. */
export const encodePrivateTrailer = Schema.encodeSync(PrivateTrailerCodecV2, strict)
/** Encodes only the branded public footer view with frozen strict options. */
export const encodePublicFooter = Schema.encodeSync(PublicFooterCodecV4, strict)
/** Encodes only the branded private footer view with frozen strict options. */
export const encodePrivateFooter = Schema.encodeSync(PrivateFooterCodecV4, strict)
/** Decodes the public trailer machine region; human text is not authoritative. */
export const decodePublicTrailer = Schema.decodeUnknownSync(PublicTrailerCodecV2, strict)
/** Decodes the private trailer machine region; human text is not authoritative. */
export const decodePrivateTrailer = Schema.decodeUnknownSync(PrivateTrailerCodecV2, strict)
/** Decodes the public footer machine region; human text is not authoritative. */
export const decodePublicFooter = Schema.decodeUnknownSync(PublicFooterCodecV4, strict)
/** Decodes the private footer machine region; human text is not authoritative. */
export const decodePrivateFooter = Schema.decodeUnknownSync(PrivateFooterCodecV4, strict)
/** Projects a validated fresh event into its generated public audience view. */
export const projectPublic = makeProjection({ schema: PublicAudienceV2, plan: publicAudiencePlan })
/** Projects a validated fresh event into its generated private audience view. */
export const projectPrivate = makeProjection({
  schema: PrivateAudienceV2,
  plan: privateAudiencePlan,
})
/** Restricts a validated fresh event to the generated public trailer view. */
export const publicTrailerView = makeProjection({
  schema: PublicTrailerV2,
  plan: publicTrailerPlan,
})
/** Restricts a validated fresh event to the generated private trailer view. */
export const privateTrailerView = makeProjection({
  schema: PrivateTrailerV2,
  plan: privateTrailerPlan,
})
/** Restricts a validated fresh event to the generated public footer view. */
export const publicFooterView = makeProjection({ schema: PublicFooterV2, plan: publicFooterPlan })
/** Restricts a validated fresh event to the generated private footer view. */
export const privateFooterView = makeProjection({
  schema: PrivateFooterV2,
  plan: privateFooterPlan,
})
/** Compares the human region with a fresh rendering of the authoritative decoded machine region. */
export const hasRenderingDrift = ({
  wire,
  audience,
  medium,
}: {
  wire: string
  audience: Audience
  medium: 'trailer' | 'footer'
}): boolean => {
  if (medium === 'trailer') {
    const view =
      audience === 'public-minimal' ? decodePublicTrailer(wire) : decodePrivateTrailer(wire)
    const human = wire.split('\n').filter((line) => line.startsWith('On-Behalf-Of:'))
    return human.length !== 1 || human[0] !== renderTrailerHuman(view)
  }
  const view = audience === 'public-minimal' ? decodePublicFooter(wire) : decodePrivateFooter(wire)
  return (
    wire.slice(footerBegin.length + 1, wire.indexOf('\n' + machineFooter)) !==
    renderFooterHuman({ view: view, audience: audience })
  )
}
export {
  PublicAudienceV2,
  PrivateAudienceV2,
  PublicTrailerV2,
  PrivateTrailerV2,
  PublicFooterV2,
  PrivateFooterV2,
}
