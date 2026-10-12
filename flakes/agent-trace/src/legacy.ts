import { Schema } from 'effect'

import {
  PrivateFooterV2,
  PrivateTrailerV2,
  PublicFooterV2,
  PublicTrailerV2,
  decodePublicTrailer,
  decodePrivateTrailer,
} from './media.ts'
import { ModelRoute, SessionLookup, strict, type Audience } from './schema.ts'
/** Historical observation preserving unknown and unavailable sentinels as tagged values. */
export type LegacyValue =
  | { readonly _tag: 'unknown' }
  | { readonly _tag: 'unavailable' }
  | { readonly _tag: 'value'; readonly value: string }
/** Frozen legacy binding observations before any upgrade is attempted. */
export type LegacyView = {
  readonly binding: 'trailer/v1' | 'footer/v3'
  readonly fields: Readonly<Record<string, LegacyValue>>
}
/** Sparse current binding views carrying only the legacy observations available on their original medium. */
export type LegacyBindingView =
  | PublicTrailerV2
  | PrivateTrailerV2
  | PublicFooterV2
  | PrivateFooterV2
const tagged = (value: string): LegacyValue =>
  value === 'unknown' || value === 'unavailable' ? { _tag: value } : { _tag: 'value', value }
/** Reads the historical agent-* and tooling-profile trailer namespace. */
export const decodeLegacyTrailer = (body: string): LegacyView => {
  const fields: Record<string, LegacyValue> = {}
  for (const line of body.split('\n')) {
    const match = /^(agent-[a-z0-9-]+|tooling-profile):[ \t]*(.*)$/i.exec(line)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    // The historic hook owned the entire agent-* namespace, including keys
    // emitted by older releases. Preserve observations without inventing facts.
    fields[key] = tagged(match[2]!.trim())
  }
  return { binding: 'trailer/v1', fields }
}
/** Reads the captured footer/v3 table inside its frozen owned markers. */
export const decodeLegacyFooter = (body: string): LegacyView => {
  const start = body.indexOf('<!-- agent-footer:begin v=3 -->'),
    end = body.indexOf('<!-- agent-footer:end -->', start)
  if (start < 0 || end < 0) throw new TypeError('Missing frozen footer/v3 region')
  const fields: Record<string, LegacyValue> = {}
  for (const line of body.slice(start, end).split('\n')) {
    const match = /^\| `([a-z_]+)` \| (.*) \|$/.exec(line)
    if (match) fields[match[1]!.replaceAll('_', '-')] = tagged(match[2]!.replaceAll('\\|', '|'))
  }
  return { binding: 'footer/v3', fields }
}
const publicIdentity = (value: string) =>
  value.startsWith('agent/') || value.startsWith('direct.') || !value.includes('.')
    ? value
    : value.slice(value.indexOf('.') + 1)
/** Upgrades observed legacy facts into a sparse current binding view without fabricating an event. */
export const upgradeLegacy = ({
  legacy,
  audience,
}: {
  legacy: LegacyView
  audience: Audience
}): LegacyBindingView => {
  const observed = (key: string): string | undefined => {
    const v = legacy.fields[key]
    return v?._tag === 'value' ? v.value : undefined
  }
  const who: Record<string, unknown> = {},
    how: Record<string, unknown> = {},
    where: Record<string, unknown> = {}
  const agent = observed('agent-identity'),
    supervisor = observed('agent-supervisor'),
    persona = observed('agent-persona')
  if (agent) who.agent = audience === 'public-minimal' ? publicIdentity(agent) : agent
  if (supervisor)
    who.supervisor = audience === 'public-minimal' ? publicIdentity(supervisor) : supervisor
  if (persona) who.persona = persona
  const tool = observed('agent-tool'),
    version = observed('agent-tool-version')
  if (tool) how.harness = { tool, ...(version ? { version } : {}) }
  const route = observed('agent-model')
  if (route && Schema.is(ModelRoute)(route))
    how.model = {
      route,
      ...(audience === 'private-rich' && observed('agent-effort')
        ? { effort: observed('agent-effort') }
        : {}),
    }
  if (audience === 'private-rich' && observed('tooling-profile'))
    how.tooling_profile = observed('tooling-profile')
  const value: Record<string, unknown> = { type: 'agent-trace/v2', who, why: {}, how }
  if (legacy.binding === 'footer/v3') {
    const session = observed('session')
    if (session && Schema.is(SessionLookup)(session))
      where.session = audience === 'public-minimal' ? session.split('.').at(-1) : session
    if (audience === 'private-rich' && observed('worktree')) where.worktree = observed('worktree')
    value.where = where
    return Schema.decodeUnknownSync(
      audience === 'public-minimal' ? PublicFooterV2 : PrivateFooterV2,
      strict,
    )(value)
  }
  return Schema.decodeUnknownSync(
    audience === 'public-minimal' ? PublicTrailerV2 : PrivateTrailerV2,
    strict,
  )(value)
}

/** Reads current or frozen legacy commit attribution; unrelated commits remain explicitly untraced. */
export const decodeCommit = ({
  wire,
  audience,
}: {
  wire: string
  audience: Audience
}): LegacyBindingView | null => {
  if (wire.split('\n').some((line) => line.startsWith('Agent-Trace:')))
    return audience === 'public-minimal' ? decodePublicTrailer(wire) : decodePrivateTrailer(wire)
  const legacy = decodeLegacyTrailer(wire)
  if (!Object.keys(legacy.fields).some((key) => key.startsWith('agent-'))) return null
  return upgradeLegacy({ legacy, audience })
}
