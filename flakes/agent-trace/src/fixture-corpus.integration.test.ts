import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { checkArtifacts } from '@schickling/schema-registry'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { CodecCorpus, fixtureArtifacts, fixtureViewSources } from './fixture-corpus.ts'
import { decodeCommit, decodeLegacyFooter, decodeLegacyTrailer, upgradeLegacy } from './legacy.ts'
import * as M from './media.ts'
import { summaryText } from './render.ts'
import { captureArtifact } from './runtime.ts'
import { AgentTraceRuntimeV1, AgentTraceV2, ModelRoute, strict } from './schema.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const corpus = Schema.decodeSync(
  Schema.fromJsonString(CodecCorpus),
  strict,
)(readFileSync(root + 'fixtures/codec-corpus.json', 'utf8'))
const codecFor = ({
  binding,
  audience,
}: {
  binding: 'trailer/v2' | 'footer/v4'
  audience: 'public-minimal' | 'private-rich'
}) =>
  binding === 'trailer/v2'
    ? audience === 'public-minimal'
      ? M.PublicTrailerCodecV2
      : M.PrivateTrailerCodecV2
    : audience === 'public-minimal'
      ? M.PublicFooterCodecV4
      : M.PrivateFooterCodecV4
const assertPairs = (
  pairs: ReadonlyArray<{ entry: CodecCorpus['cases'][number]; decoded: unknown }>,
): void => {
  const views: Record<string, unknown> = {}
  for (const { entry, decoded } of pairs) {
    if (!entry.viewPath || !entry.wirePath)
      throw new TypeError('Fixture is missing its JSON/text pair paths')
    expect(readFileSync(root + 'fixtures/' + entry.wirePath, 'utf8')).toBe(entry.wire)
    views[entry.viewPath] = decoded
  }
  const formatted = fixtureViewSources(views)
  for (const { entry } of pairs) {
    const bytes = readFileSync(root + 'fixtures/' + entry.viewPath!, 'utf8')
    const view = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(bytes)
    expect(view).toEqual(entry.view)
    expect(formatted[entry.viewPath!]).toBe(bytes)
  }
}

describe('shared TypeScript/Rust corpus', () => {
  it('is byte-identical to the deterministic TS emitter', () =>
    checkArtifacts({ repositoryRoot: root, artifacts: fixtureArtifacts() }))
  it('decodes every current view and emits its exact shared wire bytes', () => {
    const current = corpus.cases.filter((entry) => entry.kind === 'current')
    expect(current).toHaveLength(8)
    const pairs: Array<{ entry: CodecCorpus['cases'][number]; decoded: unknown }> = []
    for (const entry of current) {
      if (entry.binding !== 'trailer/v2' && entry.binding !== 'footer/v4')
        throw new TypeError('Current fixture has a legacy binding')
      const codec = codecFor({ binding: entry.binding, audience: entry.audience })
      const decoded = Schema.decodeSync(codec, strict)(entry.wire)
      pairs.push({ entry, decoded })
      expect(decoded).toEqual(entry.view)
      for (const [fact, value] of Object.entries({
        runtime_profile: 'runtime@fixture',
        skills_manifest: 'skills@fixture',
        invocation_id: entry.id.startsWith('direct-') ? 'invocation-direct' : 'invocation-managed',
      })) {
        if (entry.audience === 'private-rich') expect(decoded.how).toHaveProperty(fact, value)
        else {
          expect(decoded.how).not.toHaveProperty(fact)
          expect(entry.wire).not.toContain(fact)
        }
      }
      expect(summaryText(decoded)).toBe(entry.summary)
      if (entry.binding === 'trailer/v2')
        expect(decodeCommit({ wire: entry.wire, audience: entry.audience })).toEqual(entry.view)
      expect(Schema.encodeSync(codec, strict)(decoded)).toBe(entry.wire)
      expect(
        M.hasRenderingDrift({
          wire: entry.wire,
          audience: entry.audience,
          medium: entry.binding === 'trailer/v2' ? 'trailer' : 'footer',
        }),
      ).toBe(false)
    }
    assertPairs(pairs)
  })
  it('round-trips every runtime byte and captures only records with an active purpose', () => {
    const codec = Schema.fromJsonString(AgentTraceRuntimeV1)
    expect(corpus.runtimeCases.map((entry) => entry.id).sort()).toEqual([
      'direct-runtime',
      'idle-runtime',
      'managed-runtime',
    ])
    const issuanceTags = new Set<string>()
    for (const entry of corpus.runtimeCases) {
      const runtime = Schema.decodeSync(codec, strict)(entry.wire)
      expect(runtime).toEqual(entry.runtime)
      expect(Schema.encodeSync(codec, strict)(runtime)).toBe(entry.wire)
      for (const field of ['id', 'at', 'artifact']) expect(runtime).not.toHaveProperty(field)
      if (runtime.how.issuance !== undefined) issuanceTags.add(runtime.how.issuance._tag)
      if (entry.id === 'idle-runtime') {
        expect(runtime).not.toHaveProperty('why')
        expect(entry).not.toHaveProperty('facts')
        expect(entry).not.toHaveProperty('captured')
        expect(() =>
          captureArtifact({
            runtime,
            facts: { id: 'idle-event', at: '2026-10-10T00:00:00Z', artifact: 'commit:idle' },
          }),
        ).toThrow()
      } else {
        if (entry.facts === undefined || entry.captured === undefined)
          throw new TypeError('Active runtime fixture lacks artifact capture facts')
        const captured = captureArtifact({ runtime, facts: entry.facts })
        expect(captured).toEqual(entry.captured)
        expect(Schema.decodeUnknownSync(AgentTraceV2, strict)(entry.captured)).toEqual(captured)
        expect(captured.how.issuance).toEqual(runtime.how.issuance)
      }
    }
    expect([...issuanceTags].sort()).toEqual(['not-st-issued', 'st-issued'])
    const managed = Schema.decodeUnknownSync(
      AgentTraceRuntimeV1,
      strict,
    )(corpus.runtimeCases.find((entry) => entry.id === 'managed-runtime')?.runtime)
    const idle = Schema.decodeUnknownSync(
      AgentTraceRuntimeV1,
      strict,
    )(corpus.runtimeCases.find((entry) => entry.id === 'idle-runtime')?.runtime)
    expect(idle.who).toEqual(managed.who)
    expect(idle.how).toEqual(managed.how)
    expect(idle.where).toEqual(managed.where)
  })
  it('upgrades each frozen legacy wire and preserves its tagged observations', () => {
    const legacy = corpus.cases.filter((entry) => entry.kind === 'legacy')
    expect(legacy).toHaveLength(8)
    const pairs: Array<{ entry: CodecCorpus['cases'][number]; decoded: unknown }> = []
    for (const entry of legacy) {
      const decoded =
        entry.binding === 'trailer/v1'
          ? decodeLegacyTrailer(entry.wire)
          : decodeLegacyFooter(entry.wire)
      expect(decoded.fields).toEqual(entry.observations)
      pairs.push({ entry, decoded: upgradeLegacy({ legacy: decoded, audience: entry.audience }) })
      expect(upgradeLegacy({ legacy: decoded, audience: entry.audience })).toEqual(entry.view)
      expect(summaryText(entry.view)).toBe(entry.summary)
      if (entry.binding === 'trailer/v1')
        expect(decodeCommit({ wire: entry.wire, audience: entry.audience })).toEqual(entry.view)
    }
    assertPairs(pairs)
  })
  it('keeps unrelated commits untraced, including tooling-profile without agent attribution', () => {
    expect(corpus.untraced).toHaveLength(6)
    for (const entry of corpus.untraced)
      expect(decodeCommit({ wire: entry.wire, audience: entry.audience })).toBe(entry.trace)
    for (const entry of corpus.invalid.filter((entry) => entry.binding === 'trailer/v2'))
      expect(() => decodeCommit({ wire: entry.wire, audience: entry.audience })).toThrow()
  })
  it('rejects every shared invalid wire and enforces the UTF16 ModelRoute boundaries', () => {
    expect(corpus.invalid).toHaveLength(18)
    for (const entry of corpus.invalid)
      expect(() => Schema.decodeSync(codecFor(entry), strict)(entry.wire)).toThrow()
    for (const route of corpus.modelRoutes) {
      expect(route.value.length).toBe(route.utf16Length)
      expect(Schema.is(ModelRoute)(route.value)).toBe(route.valid)
    }
    expect(corpus.modelRoutes.find((route) => route.id === 'ascii-64')?.valid).toBe(true)
    expect(corpus.modelRoutes.find((route) => route.id === 'ascii-65')?.valid).toBe(false)
    // Supplementary characters are invalid by the approved ASCII route grammar,
    // but their lengths additionally pin Rust's encode_utf16().count() handling.
    expect(
      corpus.modelRoutes.find((route) => route.id === 'supplementary-utf16-64')?.utf16Length,
    ).toBe(64)
    expect(
      corpus.modelRoutes.find((route) => route.id === 'supplementary-utf16-65')?.utf16Length,
    ).toBe(65)
  })
})
